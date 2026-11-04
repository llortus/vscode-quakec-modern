/**
 * @file A recursive descent parser for QuakeC as accepted by gmqcc.
 *
 * The parser does not build a full syntax tree. It checks syntax, tracks
 * declarations in scopes, and records every name it sees so the language
 * server can answer hover, go-to-definition, and find-references requests.
 *
 * The `language` option mirrors gmqcc's -std flag: "gmqcc" (default),
 * "fteqcc", or "qcc".
 */

const { Position, Range } = require("./quakec-common");
const { QuakeCLexer } = require("./quakec-lexer");
const { Preprocessor, createPredefinedMacros } = require("./quakec-preprocessor");

const SEVERITY_ERROR = 1;
const SEVERITY_WARNING = 2;

const QCC_KEYWORDS = ["for", "do", "while", "if", "else", "local", "return", "const"];
const GMQCC_KEYWORDS = QCC_KEYWORDS.concat([
    "switch", "case", "default", "struct", "union", "break", "continue", "typedef", "goto",
    "__builtin_debug_printtype"
]);

const KNOWN_ATTRIBUTES = new Set([
    "noreturn", "inline", "eraseable", "noerase", "accumulate", "last", "noref", "alias",
    "deprecated", "coverage"
]);

// Binary operators: precedence and associativity, from gmqcc's c_operators.
const BINARY_OPERATORS = {
    "**": { prec: 14, right: true },
    "*": { prec: 13 }, "/": { prec: 13 }, "%": { prec: 13 }, "><": { prec: 13 },
    "+": { prec: 12 }, "-": { prec: 12 },
    "<<": { prec: 11 }, ">>": { prec: 11 },
    "<": { prec: 10 }, ">": { prec: 10 }, "<=>": { prec: 10 }, "<=": { prec: 10 }, ">=": { prec: 10 },
    "==": { prec: 9 }, "!=": { prec: 9 },
    "&": { prec: 8 },
    "^": { prec: 7 },
    "|": { prec: 6 },
    "&&": { prec: 5 },
    "||": { prec: 4 }
};

const PREC_COMMA = 1;
const PREC_ASSIGN = 2;
const PREC_TERNARY = 3;
const PREC_LOGICAL_OR = 4;

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "&~="]);

// Operators gmqcc accepts with -std=qcc.
const QCC_OPERATORS = new Set([
    "!", "+", "-", "*", "/", "&", "|", "<", ">", "<=", ">=", "==", "!=", "=", "+=", "-=",
    "*=", "/=", "%=", "&=", "|=", "&&", "||", ",", ".", "(", "["
]);

/**
 * A QuakeC type.
 */
class Type {
    /**
     * @param {string} kind One of void, int, float, string, entity, vector, nil,
     *                      field, function, array.
     * @param {Type} next Element, field, or return type.
     */
    constructor(kind, next) {
        this.kind = kind;
        this.next = next || null;

        /** @type {{name: string, type: Type}[]} Function parameters. */
        this.params = null;
        this.variadic = false;

        /** @type {Type} Type of restricted varargs, as in `string...`. */
        this.varargType = null;
        this.varargName = null;

        /** @type {number | null} Array length. */
        this.count = null;

        /** @type {Scope} Scope holding parameter definitions. */
        this.paramScope = null;
    }

    static basic(kind) {
        return new Type(kind);
    }

    static field(next) {
        return new Type("field", next);
    }

    static array(next, count) {
        const type = new Type("array", next);
        type.count = count;
        return type;
    }

    get isFunction() {
        return this.kind === "function";
    }

    /**
     * Type name as a string. Kept for compatibility, e.g. ".float".
     */
    get value() {
        return this.toString();
    }

    toString() {
        return renderType(this, "");
    }
}

/**
 * Renders a type with an optional name in QuakeC syntax, e.g.
 * `void(entity e) touch`, `.float health`, `float list[4]`.
 *
 * @param {Type} type
 * @param {string} name
 * @returns {string}
 */
const renderType = function(type, name) {
    if (!type) {
        return name;
    }

    switch (type.kind) {
        case "array":
            return renderType(type.next, `${name}[${type.count === null ? "" : type.count}]`);
        case "field":
            return "." + renderType(type.next, name);
        case "function": {
            const params = (type.params || []).map((p) => renderType(p.type, p.name));

            if (type.variadic) {
                if (type.varargType) {
                    params.push(`${renderType(type.varargType, "")}...${type.varargName ? " " + type.varargName : ""}`);
                }
                else {
                    params.push(`...${type.varargName ? " " + type.varargName : ""}`);
                }
            }

            const result = `${renderType(type.next, "")}(${params.join(", ")})`;
            return name ? `${result} ${name}` : result;
        }
        default:
            return name ? `${type.kind} ${name}` : type.kind;
    }
};

/**
 * Something with a name: a variable, field, function, parameter, typedef,
 * macro, frame, or label.
 */
class Definition {
    /**
     * @param {string} name
     * @param {string} kind
     * @param {Type} type
     * @param {Scope} scope
     * @param {Range} range
     */
    constructor(name, kind, type, scope, range) {
        this.name = name;
        this.kind = kind;
        this.type = type;
        this.scope = scope;
        this.uri = scope ? scope.uri : "";
        this.range = range;

        /** @type {{uri: string, range: Range}[]} All places this is declared. */
        this.declarations = [{ uri: this.uri, range: range }];

        this.constant = false;
        this.hasBody = false;
        this.hasValue = false;

        /** @type {string | null} Initializer text for simple constants. */
        this.initializer = null;

        /** @type {object} Preprocessor macro, for kind "macro". */
        this.macro = null;
    }

    /**
     * The name of this definition. Kept for compatibility.
     */
    get value() {
        return this.name;
    }

    /**
     * Records another declaration of the same thing. A declaration with a
     * body or value becomes the main location.
     */
    addDeclaration(uri, range, primary) {
        this.declarations.push({ uri: uri, range: range });

        if (primary) {
            this.uri = uri;
            this.range = range;
        }
    }

    /**
     * The first declaration of this global across all files.
     *
     * @returns {Definition}
     */
    get canonical() {
        let definition = this;

        while (definition.previous) {
            definition = definition.previous;
        }

        return definition;
    }

    /**
     * @returns {string} A one line description for hover.
     */
    describe() {
        switch (this.kind) {
            case "macro":
                return this.macro ? this.macro.toString() : `#define ${this.name}`;
            case "frame":
                return `$frame ${this.name.slice(1)}${this.initializer !== null ? " = " + this.initializer : ""}`;
            case "label":
                return `:${this.name}`;
            case "typedef":
                return `typedef ${renderType(this.type, this.name)}`;
        }

        let result = renderType(this.type, this.name);

        if (this.constant && !this.type.isFunction) {
            result = "const " + result;
        }

        if (this.initializer !== null && !this.type.isFunction) {
            result += ` = ${this.initializer}`;
        }

        return result;
    }
}

class Scope {
    /**
     * @param {string} uri The document this scope belongs to.
     * @param {Scope} parent
     */
    constructor(uri, parent) {
        this.uri = uri || (parent ? parent.uri : "");
        this.parent = parent || null;

        /** @type {Object.<string, Definition>} */
        this.def = Object.create(null);

        /** @type {Scope[]} Scopes brought in with #include. */
        this.imports = [];
    }

    /**
     * Finds a definition by name in this scope or any enclosing scope.
     *
     * @param {string} name
     * @returns {Definition | null}
     */
    find(name) {
        const seen = new Set();
        let scope = this;

        while (scope) {
            const found = scope.findHere(name, seen);
            if (found) {
                return found;
            }
            scope = scope.parent;
        }

        return null;
    }

    /**
     * Finds a definition in this scope or its imports, without walking up.
     */
    findHere(name, seen) {
        seen = seen || new Set();

        if (seen.has(this)) {
            return null;
        }
        seen.add(this);

        if (name in this.def) {
            return this.def[name];
        }

        for (const imported of this.imports) {
            const found = imported.find(name);
            if (found) {
                return found;
            }
        }

        return null;
    }
}

class ParseError extends Error {}

/**
 * The result of parsing a document.
 */
class Program {
    constructor(ast, scope, symbols, errors, macros, inactiveRanges) {
        this.ast = ast;
        this.scope = scope;

        /** @type {{value: string, range: Range, definition: Definition}[]} */
        this.symbols = symbols;
        this.errors = errors;

        /** @type {Map<string, object>} Macros defined at the end of the document. */
        this.macros = macros;

        /** @type {Range[]} */
        this.inactiveRanges = inactiveRanges || [];
    }

    /**
     * Returns the symbol at the given position.
     *
     * @param {Position} position
     */
    getSymbol(position) {
        for (const symbol of this.symbols) {
            if (symbol.range.contains(position)) {
                return symbol;
            }
        }

        return null;
    }

    /**
     * Get a string describing the symbol at the given position.
     *
     * @param {Position} position
     * @returns {string | null}
     */
    getTypeString(position) {
        const definition = this.getSymbolDefinition(position);

        if (!definition) {
            return null;
        }

        return definition.describe();
    }

    /**
     * Gets the location of the definition for the symbol at the given position.
     *
     * @param {Position} position
     */
    getDefinition(position) {
        const definition = this.getSymbolDefinition(position);

        if (!definition) {
            return null;
        }

        return {
            uri: definition.uri,
            range: definition.range
        };
    }

    /**
     * Gets the definition of the symbol at the given position.
     *
     * @param {Position} position
     * @returns {Definition | null}
     */
    getSymbolDefinition(position) {
        const symbol = this.getSymbol(position);

        if (!symbol) {
            return null;
        }

        return symbol.definition;
    }

    getErrors() {
        return this.errors;
    }
}

class Parser {
    /**
     * @param {object} info See `parse`.
     */
    constructor(info) {
        this.language = info.language || "gmqcc";
        this.uri = info.uri || "";
        this.text = info.program || "";

        this.keywords = new Set(this.language === "qcc" ? QCC_KEYWORDS : GMQCC_KEYWORDS);

        this.errors = [];
        this.symbols = [];

        this.globalScope = new Scope(this.uri, info.parentScope || null);
        this.scope = this.globalScope;

        this.macros = new Map(info.macros || createPredefinedMacros(this.language));

        const lexer = new QuakeCLexer();
        lexer.setInput(this.text);
        this.lexer = lexer;

        this.preprocessor = new Preprocessor(lexer, {
            macros: this.macros,
            uri: this.uri,
            diagnostic: (message, range, severity) => this.diagnostic(message, range, severity),
            onDefine: (token, macro) => this.defineMacro(token, macro),
            onMacroUse: (macro, token) => this.reference(token, macro.definition),
            include: (path, where) => this.include(path, where, info.include)
        });

        this.buffer = [];
        this.previous = null;
        this.consumed = 0;
        this.endRange = this.computeEndRange();

        // Frame macro state.
        this.frameValue = 0;

        // Function state.
        this.func = null;
    }

    computeEndRange() {
        const lines = this.text.split("\n");
        const end = new Position(lines.length - 1, lines[lines.length - 1].length);
        return new Range(end, end);
    }

    // ------------------------------------------------------------------
    // Diagnostics

    diagnostic(message, range, severity) {
        range = range || this.peek().range;

        for (const existing of this.errors) {
            if (existing.severity === severity && Position.isEqual(existing.range.start, range.start) && existing.message.endsWith(message)) {
                return;
            }
        }

        this.errors.push({
            range: range,
            severity: severity,
            message: `[${this.language}] ${message}`
        });
    }

    error(message, range) {
        this.diagnostic(message, range, SEVERITY_ERROR);
    }

    warn(message, range) {
        this.diagnostic(message, range, SEVERITY_WARNING);
    }

    /**
     * Reports an error and abandons the current statement.
     */
    fail(message, token) {
        token = token || this.peek();
        this.error(message, token.range);
        throw new ParseError(message);
    }

    unexpected(token) {
        token = token || this.peek();

        if (token.type === "eof") {
            this.fail("Unexpected end of file.", token);
        }

        this.fail(`Unexpected token: '${token.value}'`, token);
    }

    // ------------------------------------------------------------------
    // Tokens

    peek(offset = 0) {
        while (this.buffer.length <= offset) {
            const token = this.preprocessor.next();
            this.buffer.push(token || { type: "eof", value: "(end)", range: this.endRange, position: this.endRange.start });
        }

        return this.buffer[offset];
    }

    advance() {
        const token = this.peek();

        if (token.type !== "eof") {
            this.buffer.shift();
            this.consumed++;
        }

        this.previous = token;
        return token;
    }

    is(value, offset = 0) {
        const token = this.peek(offset);
        return token.type === "operator" && token.value === value;
    }

    isName(value, offset = 0) {
        const token = this.peek(offset);
        return token.type === "name" && token.value === value;
    }

    isKeyword(value, offset = 0) {
        return this.isName(value, offset) && this.keywords.has(value);
    }

    accept(value) {
        if (this.is(value)) {
            return this.advance();
        }

        return null;
    }

    expect(value) {
        if (this.is(value)) {
            return this.advance();
        }

        const token = this.peek();
        if (token.type === "eof") {
            this.fail(`Expected '${value}' but reached the end of the file.`, token);
        }

        this.fail(`Expected '${value}' but found '${token.value}'.`, token);
    }

    /**
     * Expects a semicolon. A missing semicolon is reported but parsing
     * continues as if it were there.
     */
    expectSemicolon() {
        if (this.accept(";")) {
            return;
        }

        const at = this.previous || this.peek();
        this.error("Missing semicolon.", at.range);
    }

    /**
     * True if the token begins on a later line than the previous token.
     */
    startsLine(token) {
        return !this.previous || token.range.start.line > this.previous.range.end.line;
    }

    // ------------------------------------------------------------------
    // Symbols

    /**
     * Records a use of a name.
     *
     * @param {object} token
     * @param {Definition | null} definition
     */
    reference(token, definition) {
        if (!token || token.expanded) {
            return;
        }

        this.symbols.push({
            value: token.value,
            range: token.range,
            definition: definition || null,
            scope: this.scope
        });
    }

    lookup(name) {
        return this.scope.find(name);
    }

    /**
     * Defines a name in the current scope.
     *
     * @param {object} token The name token.
     * @param {string} kind
     * @param {Type} type
     * @param {object} options
     * @returns {Definition}
     */
    define(token, kind, type, options = {}) {
        const scope = options.scope || this.scope;
        const name = token.value;
        const isGlobal = scope === this.globalScope;
        const here = name in scope.def ? scope.def[name] : null;

        // Globals share one namespace across every file in progs.src.
        const existing = here || (isGlobal ? scope.find(name) : null);

        const attributes = options.attributes || new Set();

        if (existing && existing.kind !== "frame" && kind !== "frame" && kind !== "parameter") {
            if (isGlobal && existing.attributes && existing.attributes.has("last")) {
                this.error(`Cannot redeclare '${name}', it was declared [[last]].`, token.range);
            }
            else if (isGlobal && attributes.has("last")) {
                // [[last]] marks the final declaration; no warning.
            }
            else if (existing.kind === "typedef" || kind === "typedef") {
                this.error(`'${name}' has already been declared.`, token.range);
            }
            else if (!isGlobal) {
                this.error(`Local '${name}' has already been declared.`, token.range);
            }
            else if (existing.type && type && existing.type.isFunction && type.isFunction) {
                // A prototype followed by a definition is fine.
            }
            else if (existing.kind === "field" && kind === "field") {
                this.warn(`Field '${name}' has already been declared.`, token.range);
            }
            else {
                this.warn(`'${name}' has already been declared.`, token.range);
            }
        }

        const mergeable = existing && !options.noMerge &&
            (existing.kind === kind || (isGlobal && existing.type && type && existing.type.isFunction === type.isFunction));

        if (here && mergeable) {
            here.addDeclaration(this.uri, token.range, options.primary);
            this.reference(token, here);
            return here;
        }

        if (!isGlobal && kind === "local" && this.func && scope.parent === this.func.scope && this.func.params.has(name)) {
            this.warn(`Local '${name}' is shadowing a parameter.`, token.range);
        }

        const definition = new Definition(name, kind, type, scope, token.range);
        definition.uri = this.uri;
        definition.declarations[0].uri = this.uri;

        // Link to the same global declared in an earlier file, such as a
        // prototype in defs.qc, so find-references sees both.
        if (!here && mergeable) {
            definition.previous = existing;
            definition.hasBody = existing.hasBody;
            definition.attributes = existing.attributes;
            definition.constant = existing.constant;
        }

        scope.def[name] = definition;
        this.reference(token, definition);

        if (type && !options.noComponents) {
            this.defineVectorComponents(token, definition, scope);
        }

        return definition;
    }

    /**
     * Vectors also define name_x, name_y, and name_z.
     */
    defineVectorComponents(token, definition, scope) {
        const type = definition.type;
        let componentType = null;

        if (type.kind === "vector") {
            componentType = Type.basic("float");
        }
        else if (type.kind === "field" && type.next && type.next.kind === "vector") {
            componentType = Type.field(Type.basic("float"));
        }

        if (!componentType) {
            return;
        }

        for (const axis of ["_x", "_y", "_z"]) {
            const name = definition.name + axis;

            if (name in scope.def) {
                continue;
            }

            const component = new Definition(name, definition.kind, componentType, scope, token.range);
            component.uri = this.uri;
            component.declarations[0].uri = this.uri;
            scope.def[name] = component;
        }
    }

    defineMacro(token, macro) {
        const definition = new Definition(token.value, "macro", null, this.globalScope, token.range);
        definition.uri = this.uri;
        definition.declarations[0].uri = this.uri;
        definition.macro = macro;
        macro.definition = definition;
        this.reference(token, definition);
    }

    include(path, where, resolver) {
        if (!resolver) {
            return null;
        }

        const result = resolver(path, this.uri);

        if (!result) {
            return null;
        }

        if (result.scope) {
            this.globalScope.imports.push(result.scope);
        }

        return result.macros || new Map();
    }

    pushScope() {
        this.scope = new Scope(this.uri, this.scope);
        return this.scope;
    }

    popScope() {
        this.scope = this.scope.parent;
    }

    // ------------------------------------------------------------------
    // Recovery

    /**
     * Skips tokens until the end of the current statement.
     *
     * @param {boolean} global True at file level.
     */
    synchronize(global, startToken) {
        let depth = 0;

        // Always make progress.
        if (this.peek() === startToken && this.peek().type !== "eof") {
            this.advance();
        }

        while (this.peek().type !== "eof") {
            const token = this.peek();

            if (token.type === "operator") {
                if (token.value === "{") {
                    depth++;
                }
                else if (token.value === "}") {
                    if (depth === 0) {
                        if (global) {
                            this.advance();
                            this.accept(";");
                        }
                        return;
                    }

                    depth--;

                    if (depth === 0 && global) {
                        this.advance();
                        this.accept(";");
                        return;
                    }
                }
                else if (token.value === ";" && depth === 0) {
                    this.advance();
                    return;
                }
            }

            if (depth === 0 && this.startsLine(token) && this.startsDeclaration(!global)) {
                return;
            }

            this.advance();
        }
    }

    // ------------------------------------------------------------------
    // Program

    parseProgram() {
        while (this.peek().type !== "eof") {
            const start = this.peek();

            try {
                this.parseGlobal();
            }
            catch (e) {
                if (!(e instanceof ParseError)) {
                    throw e;
                }

                this.synchronize(true, start);
            }
        }
    }

    parseGlobal() {
        const token = this.peek();

        if (token.type === "modelgen") {
            this.advance();
            this.parseModelgen(token);
            return;
        }

        if (this.isName("typedef") && this.keywords.has("typedef")) {
            this.advance();
            this.parseTypedef();
            return;
        }

        if (this.isName("enum") && this.language !== "qcc" && (this.is("{", 1) || this.is(":", 1))) {
            this.advance();
            this.parseEnum();
            return;
        }

        if (this.isName("static")) {
            this.fail("'static' is not supported at file scope.", token);
        }

        if (this.startsDeclaration(false)) {
            this.parseDeclaration(false);
            return;
        }

        if (token.type === "name" && this.keywords.has(token.value)) {
            this.fail(`Unexpected keyword: '${token.value}'`, token);
        }

        this.unexpected(token);
    }

    /**
     * Handles `$frame` and other model generation commands.
     */
    parseModelgen(token) {
        const args = token.args || [];

        switch (token.value) {
            case "frame":
            case "framesave":
                for (const word of args) {
                    if (/^[-+]?[0-9.]+$/.test(word.value)) {
                        continue;
                    }

                    const definition = this.define(
                        { value: "$" + word.value, range: word.range },
                        "frame",
                        Type.basic("float"),
                        { scope: this.globalScope, noComponents: true, noMerge: true }
                    );
                    definition.initializer = String(this.frameValue++);
                    definition.constant = true;
                }
                return;
            case "framevalue":
                if (args.length === 0 || !/^[0-9]+$/.test(args[0].value)) {
                    this.error("$framevalue requires an integer parameter.", token.range);
                    return;
                }
                this.frameValue = parseInt(args[0].value, 10);
                return;
            case "framerestore": {
                if (args.length === 0) {
                    this.error("$framerestore requires a frame name.", token.range);
                    return;
                }
                const frame = this.lookup("$" + args[0].value);
                if (!frame || frame.kind !== "frame") {
                    this.error(`Unknown frame name: '${args[0].value}'`, args[0].range);
                    return;
                }
                this.reference({ value: frame.name, range: args[0].range }, frame);
                this.frameValue = parseInt(frame.initializer, 10);
                return;
            }
            case "modelname":
                if (args.length === 0) {
                    this.error("$modelname requires a parameter.", token.range);
                }
                return;
        }
    }

    // ------------------------------------------------------------------
    // Declarations

    isTypedefName(token) {
        if (token.type !== "name") {
            return false;
        }

        const definition = this.lookup(token.value);
        return !!definition && definition.kind === "typedef";
    }

    /**
     * Does the current token start a type? (`float`, `.float`, a typedef name)
     */
    startsType(offset = 0) {
        const token = this.peek(offset);

        return token.type === "type" ||
            (token.type === "operator" && (token.value === "." || token.value === "...")) ||
            this.isTypedefName(token);
    }

    /**
     * Does the current token start a declaration?
     *
     * @param {boolean} local True inside a function.
     */
    startsDeclaration(local) {
        const token = this.peek();

        if (this.startsType()) {
            // `...(i, float)` is an expression inside functions.
            if (local && token.value === "..." && this.is("(", 1)) {
                return false;
            }

            return true;
        }

        if (token.type === "operator" && token.value === "[[") {
            return true;
        }

        if (token.type === "name") {
            switch (token.value) {
                case "const":
                case "var":
                case "noref":
                    return !this.isDeclaredVariable(token.value);
                case "local":
                    return local;
                case "static":
                    return local && !this.isDeclaredVariable("static");
                case "typedef":
                    return this.keywords.has("typedef");
            }
        }

        return false;
    }

    /**
     * `var` and friends are only keywords by context; they can still be used
     * as variable names.
     */
    isDeclaredVariable(name) {
        if (this.keywords.has(name)) {
            return false;
        }

        const definition = this.lookup(name);
        return !!definition && definition.kind !== "macro" && definition.kind !== "typedef";
    }

    /**
     * Parses qualifiers and attributes before a declaration.
     */
    parseQualifiers(local) {
        const result = { constant: false, var: false, noref: false, isStatic: false, attributes: new Set() };

        while (true) {
            const token = this.peek();

            if (token.type === "operator" && token.value === "[[") {
                this.advance();
                this.parseAttribute(result);
                continue;
            }

            if (token.type !== "name") {
                break;
            }

            if (token.value === "const") {
                result.constant = true;
            }
            else if (token.value === "var" && !this.isDeclaredVariable("var")) {
                result.var = true;
            }
            else if (token.value === "noref" && !this.isDeclaredVariable("noref")) {
                result.noref = true;
            }
            else if (token.value === "local" && local) {
                result.var = true;
            }
            else if (token.value === "static" && local) {
                result.isStatic = true;
            }
            else {
                break;
            }

            this.advance();
        }

        return result;
    }

    /**
     * Parses `[[name]]` or `[[name(args)]]`. The `[[` has been consumed.
     */
    parseAttribute(qualifiers) {
        const name = this.peek();

        if (name.type !== "name") {
            this.fail("Expected an attribute name after '[['.", name);
        }

        this.advance();

        if (!KNOWN_ATTRIBUTES.has(name.value)) {
            this.warn(`Unknown attribute: '${name.value}'`, name.range);
        }

        qualifiers.attributes.add(name.value);

        // Skip anything up to the closing brackets.
        let depth = 0;
        while (this.peek().type !== "eof") {
            if (this.is("(")) {
                depth++;
            }
            else if (this.is(")")) {
                depth--;
            }
            else if (depth <= 0 && this.is("]") && this.is("]", 1)) {
                this.advance();
                this.advance();
                return;
            }
            else if (depth <= 0 && (this.is(";") || this.is("{"))) {
                break;
            }

            this.advance();
        }

        this.fail("Expected ']]' to close the attribute.");
    }

    /**
     * Parses a type, the way gmqcc's parse_typename does.
     *
     * @param {object} options
     * @param {boolean} options.param Parsing a function parameter.
     * @param {boolean} options.noName The type has no name (as in a cast).
     * @returns {{type: Type, base: Type, name: object, vararg: boolean}}
     */
    parseTypeName(options = {}) {
        let isField = false;
        let moreFields = 0;
        let vararg = this.is("...");

        if (this.is(".") || this.is("...")) {
            isField = true;
            if (this.is("...")) {
                moreFields += 2;
            }
            this.advance();

            while (true) {
                if (this.is(".")) {
                    moreFields += 1;
                }
                else if (this.is("...")) {
                    moreFields += 3;
                }
                else {
                    break;
                }

                vararg = false;
                this.advance();
            }
        }

        const baseToken = this.peek();
        let type;

        if (baseToken.type === "type") {
            type = Type.basic(baseToken.value);
            this.advance();
        }
        else if (this.isTypedefName(baseToken)) {
            const typedef = this.lookup(baseToken.value);
            this.reference(baseToken, typedef);
            type = typedef.type;
            this.advance();
        }
        else {
            if (vararg && options.param) {
                return { vararg: true };
            }

            this.fail("Expected a type name.", baseToken);
        }

        for (; moreFields > 0; moreFields--) {
            type = Type.field(type);
        }

        // An old-style parameter list right after the type: void() foo
        if (this.is("(")) {
            type = this.parseParameterList(type);
        }

        const base = isField ? Type.field(type) : type;

        let name = null;
        const nameToken = this.peek();

        if (!options.noName && nameToken.type === "name" && !this.keywords.has(nameToken.value)) {
            name = this.advance();
        }
        else if (!options.noName && nameToken.type === "name" && nameToken.value === "break") {
            // id's defs.qc declares a `break` builtin; gmqcc warns and carries on.
            this.warn("Break definition ignored (suggest removing it).", nameToken.range);
            name = this.advance();
        }

        let wasArray = false;

        if (this.is("[")) {
            wasArray = true;
            type = this.parseArraySize(type);
        }

        if (isField) {
            type = Type.field(type);
        }

        if (this.is("(")) {
            if (this.language === "qcc") {
                this.error("C-style function syntax is not allowed with -std=qcc.", this.peek().range);
            }

            if (wasArray) {
                this.error("Arrays as part of a return type are not supported.", this.peek().range);
            }
        }

        while (this.is("(")) {
            type = this.parseParameterList(type);
        }

        return { type: type, base: base, name: name, vararg: false };
    }

    /**
     * Parses `[size]` after a name.
     */
    parseArraySize(type) {
        this.expect("[");
        let count = null;

        if (!this.is("]")) {
            const sizeToken = this.peek();
            this.parseExpression(PREC_ASSIGN);

            if (sizeToken.type === "float" && this.previous === sizeToken) {
                count = Number(sizeToken.value.replace(/f$/, ""));
            }
            else {
                count = sizeToken.value;
            }
        }

        this.expect("]");

        return Type.array(type, count);
    }

    /**
     * Parses a parameter list and returns a function type.
     *
     * @param {Type} returnType
     * @returns {Type}
     */
    parseParameterList(returnType) {
        const open = this.expect("(");
        const type = new Type("function", returnType);
        type.params = [];

        const outer = this.scope;
        type.paramScope = new Scope(this.uri, outer);
        this.scope = type.paramScope;

        try {
            let first = true;

            while (!this.is(")")) {
                if (this.peek().type === "eof") {
                    this.fail("Expected ')' to close the parameter list.", open);
                }

                if (!first) {
                    this.expect(",");
                }
                first = false;

                const param = this.parseTypeName({ param: true });

                if (param.vararg) {
                    // `...` or `...count` (the dots are already consumed)
                    type.variadic = true;

                    if (this.peek().type === "name") {
                        const counter = this.advance();
                        type.varargName = counter.value;
                        this.define(counter, "parameter", Type.basic("float"));
                    }

                    if (!this.is(")")) {
                        this.fail("'...' must be the last parameter.", this.peek());
                    }
                    break;
                }

                if (param.type.kind === "void" && !param.name && type.params.length === 0 && this.is(")")) {
                    break;
                }

                // Type-restricted varargs: `float...` or `string... count`
                if (this.is("...")) {
                    this.advance();
                    type.variadic = true;
                    type.varargType = param.type;

                    if (this.peek().type === "name") {
                        const counter = this.advance();
                        type.varargName = counter.value;
                        this.define(counter, "parameter", Type.basic("float"));
                    }
                    else if (param.name) {
                        type.varargName = param.name.value;
                        this.define(param.name, "parameter", Type.basic("float"));
                    }

                    if (!this.is(")")) {
                        this.fail("'...' must be the last parameter.", this.peek());
                    }
                    break;
                }

                if (param.name) {
                    this.define(param.name, "parameter", param.type);
                }
                else if (this.language === "fteqcc") {
                    this.error("Parameter name omitted.", this.previous.range);
                }

                type.params.push({ name: param.name ? param.name.value : "", type: param.type });
            }

            this.expect(")");
        }
        finally {
            this.scope = outer;
        }

        if (this.language === "qcc" && type.params.length > 8) {
            this.warn("More than 8 parameters are not supported by this standard.", open.range);
        }

        return type;
    }

    /**
     * Parses a variable, field, or function declaration.
     *
     * @param {boolean} local True inside a function body.
     */
    parseDeclaration(local) {
        const qualifiers = this.parseQualifiers(local);

        if (!this.startsType()) {
            if (this.isKeyword("typedef")) {
                this.advance();
                this.parseTypedef();
                return;
            }

            this.fail("Expected a type.", this.peek());
        }

        const parsed = this.parseTypeName();
        let type = parsed.type;
        let nameToken = parsed.name;

        while (true) {
            if (!nameToken) {
                this.fail("Expected a name for this declaration.", this.peek());
            }

            const kind = this.kindFor(type, local);
            const declaresBody = type.isFunction && (this.is("{") || this.is("[") || (this.is("=") && (this.is("{", 1) || this.is("[", 1) || this.is("#", 1))));
            const declaresValue = this.is("=");

            const definition = this.define(nameToken, kind, type, { primary: declaresBody || declaresValue, attributes: qualifiers.attributes });
            definition.constant = definition.constant || qualifiers.constant;
            definition.attributes = new Set([...(definition.attributes || []), ...qualifiers.attributes]);

            const finished = this.parseInitializer(definition, type, local, qualifiers);

            if (finished) {
                // A function body ends the declaration; a ';' is optional
                // except with -std=qcc.
                if (!this.accept(";") && this.language === "qcc") {
                    this.error("Missing semicolon after function body (mandatory with -std=qcc).", this.previous.range);
                }
                return;
            }

            if (!this.accept(",")) {
                break;
            }

            // The next name shares the base type.
            nameToken = this.peek();
            if (nameToken.type !== "name" || this.keywords.has(nameToken.value)) {
                this.fail("Expected another name after ','.", nameToken);
            }
            this.advance();

            type = parsed.base;

            if (this.is("[")) {
                type = this.parseArraySize(type);
            }

            while (this.is("(")) {
                type = this.parseParameterList(type);
            }
        }

        this.expectSemicolon();
    }

    kindFor(type, local) {
        if (local) {
            return "local";
        }

        if (type.isFunction) {
            return "function";
        }

        if (type.kind === "field") {
            return "field";
        }

        return "variable";
    }

    /**
     * Parses what follows a declared name: an initializer, builtin number,
     * or function body.
     *
     * @returns {boolean} True if a function body was parsed.
     */
    parseInitializer(definition, type, local, qualifiers) {
        const hasEquals = !!this.accept("=");

        if (type.isFunction && (this.is("{") || this.is("["))) {
            if (!hasEquals && this.language === "qcc") {
                this.error("Expected '=' before function body with -std=qcc.", this.peek().range);
            }

            if (local) {
                this.fail("Functions cannot be defined inside functions.", this.peek());
            }

            if (definition.hasBody && !(qualifiers.attributes.has("accumulate") || (definition.attributes && definition.attributes.has("accumulate")))) {
                this.error(`Function '${definition.name}' declared with multiple bodies.`, definition.declarations[definition.declarations.length - 1].range);
            }

            definition.hasBody = true;
            this.parseFunctionBody(definition, type);
            return true;
        }

        if (!hasEquals) {
            return false;
        }

        if (this.is("#")) {
            const hash = this.advance();

            if (local) {
                this.error("Builtins cannot be declared inside functions.", hash.range);
            }

            if (!type.isFunction) {
                this.error(`'${definition.name}' is not a function and cannot be a builtin.`, hash.range);
            }

            this.parseExpression(PREC_ASSIGN);

            // FTEQCC style `#0:name` builtin aliases.
            if (this.accept(":")) {
                if (this.peek().type === "name") {
                    this.advance();
                }
            }

            definition.hasBody = true;
            return false;
        }

        if (type.kind === "array" && this.is("{")) {
            if (local) {
                this.error("Initializers for local arrays are not supported.", this.peek().range);
            }

            this.parseArrayInitializer();
            definition.hasValue = true;
            return false;
        }

        const start = this.peek();
        const before = this.consumed;
        this.parseExpression(PREC_ASSIGN);
        definition.hasValue = true;

        // Remember simple constant values for hover.
        if (!local) {
            const used = this.consumed - before;
            const end = this.previous;
            if (used === 1 && ["float", "string", "vector", "char"].includes(start.type)) {
                definition.initializer = start.value;
            }
            else if (used === 2 && start.value === "-" && end.type === "float") {
                definition.initializer = "-" + end.value;
            }
        }

        if (!local && !qualifiers.var && this.language !== "gmqcc") {
            definition.constant = true;
        }

        return false;
    }

    parseArrayInitializer() {
        this.expect("{");

        while (!this.is("}")) {
            this.parseExpression(PREC_ASSIGN);

            if (!this.accept(",")) {
                break;
            }
        }

        this.expect("}");
    }

    /**
     * Parses a function body: an optional `[frame, think]` followed by a block.
     */
    parseFunctionBody(definition, type) {
        const outerFunc = this.func;
        const outerScope = this.scope;

        // Parameters live in the function's outermost scope.
        const functionScope = new Scope(this.uri, this.scope);
        const params = new Map();

        if (type.paramScope) {
            for (const name in type.paramScope.def) {
                functionScope.def[name] = type.paramScope.def[name];
                params.set(name, type.paramScope.def[name]);
            }
        }

        this.func = {
            definition: definition,
            labels: new Map(),
            gotos: [],
            loops: 0,
            switches: 0,
            params: params,
            scope: functionScope
        };

        this.scope = functionScope;

        try {
            if (this.accept("[")) {
                this.parseExpression(PREC_ASSIGN);
                this.expect(",");
                this.parseExpression(PREC_ASSIGN);
                this.expect("]");
            }

            this.parseBlock();

            for (const pending of this.func.gotos) {
                const label = this.func.labels.get(pending.value);
                if (label) {
                    this.reference(pending, label);
                }
                else {
                    this.error(`Undefined label: '${pending.value}'`, pending.range);
                }
            }
        }
        finally {
            this.func = outerFunc;
            this.scope = outerScope;
        }
    }

    /**
     * typedef <type> <name>;  The `typedef` keyword has been consumed.
     */
    parseTypedef() {
        const parsed = this.parseTypeName();

        if (!parsed.name) {
            this.fail("Missing name in typedef.", this.peek());
        }

        const existing = this.lookup(parsed.name.value);
        if (existing && existing.kind !== "typedef" && existing.kind !== "macro" && existing.scope === this.scope) {
            this.fail(`Cannot define a type with the same name as a variable: '${parsed.name.value}'`, parsed.name);
        }

        this.define(parsed.name, "typedef", parsed.type, { noComponents: true });
        this.expectSemicolon();
    }

    /**
     * enum [: flag | reverse] { A, B = 2, C };  `enum` has been consumed.
     */
    parseEnum() {
        let flag = false;
        let reverse = false;

        if (this.accept(":")) {
            const attribute = this.peek();

            if (attribute.type === "name" && attribute.value === "flag") {
                flag = true;
            }
            else if (attribute.type === "name" && attribute.value === "reverse") {
                reverse = true;
            }
            else {
                this.fail("Expected 'flag' or 'reverse' for enumeration attribute.", attribute);
            }

            this.advance();
        }

        this.expect("{");

        const values = [];
        let num = flag ? 1 : 0;
        let known = true;

        while (!this.is("}")) {
            const name = this.peek();

            if (name.type !== "name") {
                this.fail("Expected an identifier or '}'.", name);
            }

            this.advance();

            const existing = this.lookup(name.value);
            if (existing && existing.scope === this.globalScope && existing.kind !== "macro") {
                this.error(`'${name.value}' has already been declared.`, name.range);
            }

            const definition = this.define(name, "constant", Type.basic("float"), { noComponents: true, noMerge: true });
            definition.constant = true;
            values.push(definition);

            // Same numbering as gmqcc: flags double, others count up.
            let value = flag ? (num *= 2) : num++;

            if (this.accept("=")) {
                const start = this.peek();
                const before = this.consumed;
                this.parseExpression(PREC_ASSIGN);

                if (this.consumed - before === 1 && start.type === "float") {
                    value = Number(start.value.replace(/f$/, ""));
                    known = true;
                }
                else {
                    known = false;
                }

                num = value + 1;
            }

            definition.initializer = known ? String(value) : null;

            if (!this.accept(",")) {
                break;
            }
        }

        this.expect("}");

        if (reverse) {
            values.forEach((definition, i) => {
                definition.initializer = String(values.length - i - 1);
            });
        }

        this.expectSemicolon();
    }

    // ------------------------------------------------------------------
    // Statements

    /**
     * Parses `{ statements }` in a new scope.
     */
    parseBlock() {
        const open = this.expect("{");
        this.pushScope();

        try {
            this.parseStatements(open, false);
        }
        finally {
            this.popScope();
        }
    }

    /**
     * Parses statements up to and including the closing '}'.
     */
    parseStatements(open, inSwitch) {
        while (!this.is("}")) {
            const start = this.peek();

            if (start.type === "eof") {
                this.error("Expected '}' but reached the end of the file.", open.range);
                return;
            }

            try {
                if (inSwitch && (this.isKeyword("case") || this.isKeyword("default"))) {
                    this.parseCaseLabel();
                    continue;
                }

                this.parseStatement();
            }
            catch (e) {
                if (!(e instanceof ParseError)) {
                    throw e;
                }

                this.synchronize(false, start);
            }
        }

        this.advance();
    }

    parseCaseLabel() {
        const token = this.advance();

        if (token.value === "case") {
            this.parseExpression(PREC_LOGICAL_OR);
        }

        this.expect(":");
    }

    /**
     * Parses a statement, or a block of statements.
     */
    parseStatement() {
        const token = this.peek();

        if (token.type === "operator") {
            switch (token.value) {
                case "{":
                    this.parseBlock();
                    return;
                case ";":
                    this.advance();
                    return;
                case ":":
                    this.parseLabel();
                    return;
            }
        }

        if (token.type === "name" && this.keywords.has(token.value)) {
            switch (token.value) {
                case "if": this.parseIf(); return;
                case "while": this.parseWhile(); return;
                case "do": this.parseDoWhile(); return;
                case "for": this.parseFor(); return;
                case "switch": this.parseSwitch(); return;
                case "return": this.parseReturn(); return;
                case "break":
                case "continue": this.parseBreakContinue(); return;
                case "goto": this.parseGoto(); return;
                case "typedef":
                    this.advance();
                    this.parseTypedef();
                    return;
                case "local":
                case "const":
                    this.parseDeclaration(true);
                    return;
                case "case":
                case "default":
                    this.fail(`Unexpected '${token.value}' outside of a switch.`, token);
                    break;
                case "__builtin_debug_printtype":
                    this.advance();
                    this.parseStatement();
                    return;
                default:
                    this.fail(`Unexpected keyword: '${token.value}'`, token);
            }
        }

        if (token.type === "modelgen") {
            this.advance();
            this.parseModelgen(token);
            return;
        }

        if (this.startsDeclaration(true)) {
            this.parseDeclaration(true);
            return;
        }

        this.parseExpression(PREC_COMMA);
        this.expectSemicolon();
    }

    /**
     * :label
     */
    parseLabel() {
        this.expect(":");
        const name = this.peek();

        if (name.type !== "name") {
            this.fail("Label must be an identifier.", name);
        }

        this.advance();

        if (!this.func) {
            return;
        }

        if (this.func.labels.has(name.value)) {
            this.error(`Label '${name.value}' already defined.`, name.range);
            this.reference(name, this.func.labels.get(name.value));
            return;
        }

        const definition = new Definition(name.value, "label", null, this.scope, name.range);
        definition.uri = this.uri;
        definition.declarations[0].uri = this.uri;
        this.func.labels.set(name.value, definition);
        this.reference(name, definition);
    }

    /**
     * Parses an optional loop label: `while :name (...)`.
     */
    parseLoopLabel() {
        if (this.is(":")) {
            this.advance();
            const name = this.peek();

            if (name.type !== "name") {
                this.fail("Expected a loop label.", name);
            }

            this.advance();
        }
    }

    parseCondition() {
        this.expect("(");
        this.parseExpression(PREC_COMMA);
        this.expect(")");
    }

    parseIf() {
        this.advance();

        if (this.isName("not")) {
            this.advance();
        }

        this.parseCondition();
        this.parseStatement();

        if (this.isKeyword("else")) {
            this.advance();
            this.parseStatement();
        }
    }

    parseLoopBody() {
        this.func.loops++;
        try {
            this.parseStatement();
        }
        finally {
            this.func.loops--;
        }
    }

    parseWhile() {
        this.advance();
        this.parseLoopLabel();
        this.parseCondition();
        this.parseLoopBody();
    }

    parseDoWhile() {
        this.advance();
        this.parseLoopLabel();
        this.parseLoopBody();

        if (!this.isKeyword("while")) {
            this.fail("Expected 'while' after 'do' loop body.", this.peek());
        }

        this.advance();
        this.parseCondition();
        this.expectSemicolon();
    }

    parseFor() {
        const token = this.advance();

        if (this.language === "qcc") {
            this.warn("For loops are not part of the original QuakeC standard.", token.range);
        }

        this.parseLoopLabel();
        this.expect("(");
        this.pushScope();

        try {
            // Initializer: a declaration or an expression.
            if (this.startsDeclaration(true)) {
                this.parseDeclaration(true);
            }
            else {
                if (!this.is(";")) {
                    this.parseExpression(PREC_COMMA);
                }
                this.expect(";");
            }

            if (!this.is(";")) {
                this.parseExpression(PREC_COMMA);
            }
            this.expect(";");

            if (!this.is(")")) {
                this.parseExpression(PREC_COMMA);
            }
            this.expect(")");

            this.parseLoopBody();
        }
        finally {
            this.popScope();
        }
    }

    parseSwitch() {
        this.advance();
        this.parseLoopLabel();
        this.parseCondition();

        const open = this.expect("{");
        this.pushScope();
        this.func.switches++;

        try {
            this.parseStatements(open, true);
        }
        finally {
            this.func.switches--;
            this.popScope();
        }
    }

    parseReturn() {
        this.advance();

        // `return = value;` sets the return value without returning.
        if (this.accept("=")) {
            this.parseExpression(PREC_ASSIGN);
            this.expectSemicolon();
            return;
        }

        if (!this.is(";")) {
            this.parseExpression(PREC_COMMA);
        }

        this.expectSemicolon();
    }

    parseBreakContinue() {
        const token = this.advance();

        if (token.value === "continue" && this.func.loops === 0) {
            this.error("'continue' can only be used inside loops.", token.range);
        }
        else if (token.value === "break" && this.func.loops === 0 && this.func.switches === 0) {
            this.error("'break' can only be used inside loops or switches.", token.range);
        }

        // Optional loop label.
        if (this.peek().type === "name" && !this.keywords.has(this.peek().value)) {
            this.advance();
        }

        this.expectSemicolon();
    }

    /**
     * goto label;  or  goto condition ? label1 : label2;
     */
    parseGoto() {
        this.advance();

        const outer = this.gotoMode;
        this.gotoMode = true;

        try {
            this.parseExpression(PREC_COMMA);
        }
        finally {
            this.gotoMode = outer;
        }

        this.expectSemicolon();
    }

    // ------------------------------------------------------------------
    // Expressions

    /**
     * Parses an expression with operators of at least the given precedence.
     *
     * @param {number} minPrec PREC_COMMA allows the comma operator,
     *                         PREC_ASSIGN stops at commas.
     */
    parseExpression(minPrec) {
        let left = this.parseUnary();

        while (true) {
            const token = this.peek();

            if (token.type !== "operator") {
                break;
            }

            const op = token.value;
            const binary = BINARY_OPERATORS[op];

            if (binary && binary.prec >= minPrec) {
                this.advance();
                this.checkOperator(token);
                this.parseExpression(binary.right ? binary.prec : binary.prec + 1);
                left = { kind: "binary", token: token };
                continue;
            }

            if (op === "?" && PREC_TERNARY >= minPrec) {
                this.advance();
                this.checkOperator(token);
                this.parseExpression(PREC_ASSIGN);
                this.expect(":");
                this.parseExpression(PREC_TERNARY);
                left = { kind: "ternary", token: token };
                continue;
            }

            if (ASSIGNMENT_OPERATORS.has(op) && PREC_ASSIGN >= minPrec) {
                this.advance();
                this.checkOperator(token);
                this.parseExpression(PREC_ASSIGN);
                left = { kind: "assignment", token: token };
                continue;
            }

            if (op === "," && PREC_COMMA >= minPrec) {
                this.advance();
                this.parseExpression(PREC_ASSIGN);
                left = { kind: "comma", token: token };
                continue;
            }

            break;
        }

        return left;
    }

    checkOperator(token) {
        if (this.language === "qcc" && !QCC_OPERATORS.has(token.value)) {
            this.error(`Operator '${token.value}' is not available with -std=qcc.`, token.range);
        }
    }

    parseUnary() {
        const token = this.peek();

        if (token.type === "operator") {
            switch (token.value) {
                case "!":
                case "~":
                case "-":
                case "+":
                case "++":
                case "--":
                    this.advance();
                    this.checkOperator(token);
                    this.parseUnary();
                    return { kind: "unary", token: token };
            }
        }

        if (token.type === "name" && token.value === "_length" && !this.lookup("_length")) {
            this.advance();
            this.parseUnary();
            return { kind: "unary", token: token };
        }

        let expression = this.parsePrimary();

        // Postfix operators.
        while (true) {
            if (this.is("(")) {
                this.parseCall();
                expression = { kind: "call", token: expression.token };
            }
            else if (this.is("[")) {
                this.advance();
                this.parseExpression(PREC_COMMA);
                this.expect("]");
                expression = { kind: "index", token: expression.token };
            }
            else if (this.is(".")) {
                this.advance();
                this.parseMember();
                expression = { kind: "member", token: expression.token };
            }
            else if (this.is("++") || this.is("--")) {
                this.checkOperator(this.advance());
                expression = { kind: "postfix", token: expression.token };
            }
            else {
                break;
            }
        }

        return expression;
    }

    parseCall() {
        this.expect("(");

        if (!this.is(")")) {
            while (true) {
                this.parseExpression(PREC_ASSIGN);

                if (!this.accept(",")) {
                    break;
                }
            }
        }

        this.expect(")");
    }

    /**
     * Parses what follows a '.': a field name, a vector component, or a
     * parenthesized field expression.
     */
    parseMember() {
        const token = this.peek();

        if (token.type === "operator" && token.value === "(") {
            this.advance();
            this.parseExpression(PREC_COMMA);
            this.expect(")");
            return;
        }

        if (token.type !== "name") {
            this.fail("Expected a field name after '.'.", token);
        }

        this.advance();
        this.reference(token, this.lookup(token.value));
    }

    parsePrimary() {
        const token = this.peek();

        switch (token.type) {
            case "float":
            case "char":
            case "vector":
                this.advance();
                return { kind: "literal", token: token };
            case "string":
                this.advance();
                // Adjacent strings are joined.
                while (this.peek().type === "string") {
                    this.advance();
                }
                return { kind: "literal", token: token };
            case "frame": {
                this.advance();
                const frame = this.lookup("$" + token.value);

                if (frame && frame.kind === "frame") {
                    this.reference(token, frame);
                }
                else {
                    this.error(`Unknown frame macro: '$${token.value}'`, token.range);
                }

                return { kind: "literal", token: token };
            }
            case "name":
                return this.parseName();
            case "type":
                this.fail(`Unexpected type name: '${token.value}'`, token);
                break;
            case "operator":
                if (token.value === "(") {
                    this.advance();
                    this.parseExpression(PREC_COMMA);
                    this.expect(")");
                    return { kind: "group", token: token };
                }

                if (token.value === "...") {
                    return this.parseVarargAccess();
                }
                break;
        }

        if (token.type === "eof") {
            this.fail("Expected an expression but reached the end of the file.", token);
        }

        this.fail(`Expected an expression but found '${token.value}'.`, token);
    }

    parseName() {
        const token = this.peek();

        if (this.keywords.has(token.value)) {
            this.fail(`Unexpected keyword: '${token.value}'`, token);
        }

        this.advance();

        if (this.gotoMode && this.func) {
            const variable = this.lookup(token.value);

            if (!variable || variable.kind === "macro") {
                const label = this.func.labels.get(token.value);

                if (label) {
                    this.reference(token, label);
                }
                else {
                    this.func.gotos.push(token);
                }

                return { kind: "label", token: token };
            }
        }

        this.reference(token, this.lookup(token.value));

        // __FUNC__ is a string and can be joined with adjacent strings.
        if (token.value === "__FUNC__") {
            while (this.peek().type === "string") {
                this.advance();
            }
        }

        return { kind: "name", token: token };
    }

    /**
     * ...(index, type)
     */
    parseVarargAccess() {
        const token = this.advance();

        if (!this.is("(")) {
            return { kind: "vararg", token: token };
        }

        this.advance();
        this.parseExpression(PREC_ASSIGN);
        this.expect(",");
        this.parseTypeName({ noName: true });
        this.expect(")");

        return { kind: "vararg", token: token };
    }
}

/**
 * Parses a QuakeC document.
 *
 * @param {object} programInfo
 * @param {string} programInfo.program Source text.
 * @param {string} programInfo.uri Document uri.
 * @param {Scope} programInfo.parentScope Scope of the previous document in progs.src order.
 * @param {Map} programInfo.macros Macros defined by previous documents.
 * @param {string} programInfo.language gmqcc, fteqcc, or qcc.
 * @param {(path: string, fromUri: string) => ({scope: Scope, macros: Map} | null)} programInfo.include
 * @returns {Program}
 */
const parse = function(programInfo) {
    const parser = new Parser(programInfo);

    try {
        parser.parseProgram();
    }
    catch (e) {
        const range = parser.peek().range;
        parser.errors.push({
            range: range,
            severity: SEVERITY_ERROR,
            message: `[${parser.language}] fatal error: ${e.toString()}`
        });
    }

    for (const error of parser.lexer.errors) {
        parser.error(error.message, error.range);
    }

    return new Program(null, parser.globalScope, parser.symbols, parser.errors, parser.macros, parser.preprocessor.inactiveRanges);
};

if (typeof require !== 'undefined' && typeof exports !== 'undefined') {
    exports.parse = parse;
    exports.Program = Program;
    exports.Scope = Scope;
    exports.Definition = Definition;
    exports.Type = Type;
    exports.renderType = renderType;
}
