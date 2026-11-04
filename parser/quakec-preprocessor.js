/**
 * @file A token-level preprocessor modeled on gmqcc's ftepp.
 *
 * It handles #define/#undef, conditional compilation, #include, and macro
 * expansion while keeping source positions. Tokens produced by a macro
 * expansion are marked with `expanded` and take the range of the macro name
 * that produced them, so diagnostics land on the macro use.
 */

const { Position, Range } = require("./quakec-common");
const { QuakeCLexer } = require("./quakec-lexer");

/**
 * A preprocessor macro.
 */
class Macro {
    /**
     * @param {string} name
     * @param {string[] | null} params Parameter names, or null for object-like macros.
     * @param {boolean} variadic
     * @param {object[]} body Body tokens.
     */
    constructor(name, params, variadic, body) {
        this.name = name;
        this.params = params;
        this.variadic = variadic;
        this.body = body;

        /** @type {object} The Definition for this macro, if declared in source. */
        this.definition = null;
    }

    /**
     * @returns {string} The macro as it would be written in source.
     */
    toString() {
        let params = "";

        if (this.params) {
            const names = this.params.slice();
            if (this.variadic) {
                names.push("...");
            }
            params = `(${names.join(", ")})`;
        }

        const body = tokensToText(this.body);

        return `#define ${this.name}${params}${body ? " " + body : ""}`;
    }
}

/**
 * Joins tokens back into source text.
 *
 * @param {object[]} tokens
 * @returns {string}
 */
const tokensToText = function(tokens) {
    let text = "";
    let previous = null;

    for (const token of tokens) {
        if (previous && needsSpace(previous, token)) {
            text += " ";
        }

        text += token.value;
        previous = token;
    }

    return text;
};

const needsSpace = function(previous, token) {
    if (previous.range && token.range && !previous.expanded && !token.expanded) {
        const end = previous.range.end;
        const start = token.range.start;
        return end.line !== start.line || end.character !== start.character;
    }

    return true;
};

/**
 * Builds the predefined macros for a given language standard.
 *
 * @param {string} language
 * @returns {Map<string, Macro>}
 */
const createPredefinedMacros = function(language) {
    const macros = new Map();
    const add = function(name, value) {
        const body = value === undefined ? [] : lexTokens(value);
        macros.set(name, new Macro(name, null, false, body));
    };

    add("GMQCC");

    if (language === "fteqcc") {
        add("__STD_FTEQCC__");
        add("__STD_VERSION_MAJOR__", "\"1\"");
        add("__STD_VERSION_MINOR__", "\"0\"");
    }
    else if (language === "qcc") {
        add("__STD_QCC__");
        add("__STD_VERSION_MAJOR__", "\"1\"");
        add("__STD_VERSION_MINOR__", "\"0\"");
    }
    else {
        add("__STD_GMQCC__");
        add("__STD_VERSION_MAJOR__", "\"0\"");
        add("__STD_VERSION_MINOR__", "\"3\"");
    }

    add("__NULL__", "nil");

    return macros;
};

/**
 * Tokenizes a string.
 *
 * @param {string} text
 * @returns {object[]}
 */
const lexTokens = function(text) {
    const lexer = new QuakeCLexer();
    lexer.setInput(text);
    const tokens = [];
    let token;

    while ((token = lexer.lex())) {
        if (token.type !== "eol") {
            tokens.push(token);
        }
    }

    return tokens;
};

// Names whose value depends on where they are used.
const DYNAMIC_MACROS = new Set([
    "__LINE__", "__FILE__", "__COUNTER__", "__COUNTER_LAST__", "__RANDOM__",
    "__RANDOM_LAST__", "__DATE__", "__TIME__", "__TIME_STAMP__"
]);

class Preprocessor {
    /**
     * @param {QuakeCLexer} lexer
     * @param {object} options
     * @param {Map<string, Macro>} options.macros Macros defined so far. Will be modified.
     * @param {string} options.uri Current document.
     * @param {(message: string, range: Range, severity: number) => void} options.diagnostic
     * @param {(name: string, macro: Macro, token: object) => void} options.onDefine Called for #define.
     * @param {(macro: Macro, token: object) => void} options.onMacroUse Called when a macro is expanded.
     * @param {(path: string, token: object) => (Map<string, Macro> | null)} options.include Handles #include.
     */
    constructor(lexer, options) {
        this.lexer = lexer;
        this.macros = options.macros;
        this.uri = options.uri || "";
        this.diagnostic = options.diagnostic || function() {};
        this.onDefine = options.onDefine || function() {};
        this.onMacroUse = options.onMacroUse || function() {};
        this.include = options.include || function() { return null; };

        /** Tokens waiting to be returned, already expanded or ready for rescanning. */
        this.pending = [];

        /** Conditional stack: {active, taken, sawElse, parentActive, token} */
        this.conditions = [];

        this.counter = 0;
        this.random = 0;

        /** Ranges of source that were skipped by conditional compilation. */
        this.inactiveRanges = [];
    }

    get active() {
        return this.conditions.length === 0 || this.conditions[this.conditions.length - 1].active;
    }

    error(message, range) {
        this.diagnostic(message, range, 1);
    }

    warn(message, range) {
        this.diagnostic(message, range, 2);
    }

    /**
     * Reads a raw token from the pending queue or lexer.
     */
    raw() {
        if (this.pending.length > 0) {
            return this.pending.shift();
        }

        return this.lexer.lex();
    }

    /**
     * Returns the next fully preprocessed token, or undefined at the end.
     */
    next() {
        while (true) {
            const token = this.raw();

            if (!token) {
                for (const condition of this.conditions) {
                    this.error(`Unterminated #${condition.token.value}.`, condition.token.range);
                }
                this.conditions = [];
                return undefined;
            }

            if (token.type === "directive") {
                this.directive(token);
                continue;
            }

            if (token.type === "eol") {
                continue;
            }

            if (!this.active) {
                continue;
            }

            if (token.type === "name" || token.type === "type") {
                if (this.tryExpand(token)) {
                    continue;
                }
            }

            return token;
        }
    }

    /**
     * Reads the remaining tokens of a directive line.
     *
     * @returns {object[]}
     */
    readLine() {
        const tokens = [];
        let token;

        while ((token = this.lexer.lex()) && token.type !== "eol") {
            tokens.push(token);
        }

        return tokens;
    }

    /**
     * Handles a preprocessor directive.
     *
     * @param {object} token The directive token.
     */
    directive(token) {
        const name = token.value;
        const line = this.readLine();
        const lineRange = line.length > 0 ? new Range(token.range.start, line[line.length - 1].range.end) : token.range;

        switch (name) {
            case "ifdef":
            case "ifndef": {
                const parentActive = this.active;
                let value = false;

                if (line.length === 0 || (line[0].type !== "name" && line[0].type !== "type")) {
                    if (parentActive) {
                        this.error(`#${name} expects a macro name.`, lineRange);
                    }
                }
                else {
                    value = this.macros.has(line[0].value) || DYNAMIC_MACROS.has(line[0].value);
                    if (parentActive) {
                        this.markMacroUse(line[0]);
                    }
                }

                if (name === "ifndef") {
                    value = !value;
                }

                this.pushCondition(token, parentActive && value, value);
                return;
            }
            case "if": {
                const parentActive = this.active;
                const value = parentActive ? this.evaluate(line, lineRange) : false;
                this.pushCondition(token, parentActive && value, value);
                return;
            }
            case "elif":
            case "elifdef":
            case "elifndef": {
                const condition = this.conditions[this.conditions.length - 1];

                if (!condition) {
                    this.error(`#${name} without #if.`, lineRange);
                    return;
                }

                if (condition.sawElse) {
                    this.error(`#${name} after #else.`, lineRange);
                }

                if (condition.taken || !condition.parentActive) {
                    this.setActive(condition, false, token);
                    return;
                }

                let value;
                if (name === "elif") {
                    value = this.evaluate(line, lineRange);
                }
                else {
                    value = line.length > 0 && this.macros.has(line[0].value);
                    if (name === "elifndef") {
                        value = !value;
                    }
                }

                condition.taken = value;
                this.setActive(condition, value, token);
                return;
            }
            case "else": {
                const condition = this.conditions[this.conditions.length - 1];

                if (!condition) {
                    this.error("#else without #if.", lineRange);
                    return;
                }

                if (condition.sawElse) {
                    this.error("Multiple #else for the same #if.", lineRange);
                }

                condition.sawElse = true;
                this.setActive(condition, condition.parentActive && !condition.taken, token);
                condition.taken = true;
                return;
            }
            case "endif": {
                const condition = this.conditions.pop();

                if (!condition) {
                    this.error("#endif without #if.", lineRange);
                    return;
                }

                if (!condition.active) {
                    this.closeInactive(condition, token);
                }
                return;
            }
        }

        if (!this.active) {
            return;
        }

        switch (name) {
            case "define":
                this.define(token, line, lineRange);
                return;
            case "undef":
                if (line.length > 0) {
                    this.markMacroUse(line[0]);
                    this.macros.delete(line[0].value);
                }
                else {
                    this.error("#undef expects a macro name.", lineRange);
                }
                return;
            case "include": {
                const expanded = this.expandLine(line);
                const target = expanded[0];

                if (!target || target.type !== "string") {
                    // Also accept <file> style includes.
                    if (target && target.value === "<") {
                        const close = expanded.findIndex((t) => t.value === ">");
                        if (close > 0) {
                            const path = expanded.slice(1, close).map((t) => t.value).join("");
                            this.includeFile(path, lineRange);
                            return;
                        }
                    }

                    this.error("#include expects a file name.", lineRange);
                    return;
                }

                this.includeFile(target.value.slice(1, -1), lineRange);
                return;
            }
            case "error":
                this.error(`#error ${tokensToText(line)}`, lineRange);
                return;
            case "warning":
                this.warn(`#warning ${tokensToText(line)}`, lineRange);
                return;
            case "pragma":
            case "message":
                return;
            default:
                this.error(`Unknown preprocessor directive: #${name}`, token.range);
        }
    }

    includeFile(path, range) {
        const macros = this.include(path, { range: range });

        if (macros === null) {
            this.warn(`Could not find included file: '${path}'`, range);
            return;
        }

        if (macros) {
            for (const [name, macro] of macros) {
                this.macros.set(name, macro);
            }
        }
    }

    pushCondition(token, active, value) {
        const parentActive = this.active;
        const condition = {
            active: active,
            taken: value,
            sawElse: false,
            parentActive: parentActive,
            token: token,
            inactiveStart: null
        };

        this.conditions.push(condition);

        if (!active) {
            condition.inactiveStart = token.range.start;
        }
    }

    setActive(condition, active, token) {
        if (condition.active && !active) {
            condition.inactiveStart = token.range.start;
        }
        else if (!condition.active && active) {
            this.closeInactive(condition, token);
        }

        condition.active = active;
    }

    closeInactive(condition, token) {
        if (condition.inactiveStart && condition.parentActive) {
            this.inactiveRanges.push(new Range(condition.inactiveStart, token.range.end));
        }

        condition.inactiveStart = null;
    }

    /**
     * Handles #define.
     */
    define(token, line, lineRange) {
        const nameToken = line[0];

        if (!nameToken || (nameToken.type !== "name" && nameToken.type !== "type")) {
            this.error("#define expects a macro name.", lineRange);
            return;
        }

        let params = null;
        let variadic = false;
        let index = 1;
        const open = line[1];

        // A '(' right after the name starts a parameter list.
        if (open && open.value === "(" && Position.isEqual(open.range.start, nameToken.range.end)) {
            params = [];
            index = 2;

            while (index < line.length && line[index].value !== ")") {
                const param = line[index];

                if (param.value === "...") {
                    variadic = true;
                }
                else if (param.type === "name" || param.type === "type") {
                    params.push(param.value);
                }
                else if (param.value !== ",") {
                    this.error("Invalid macro parameter.", param.range);
                }

                index++;
            }

            if (index >= line.length) {
                this.error("Missing ')' in macro parameter list.", lineRange);
                return;
            }

            index++;
        }

        const macro = new Macro(nameToken.value, params, variadic, line.slice(index));
        this.macros.set(macro.name, macro);
        this.onDefine(nameToken, macro);
    }

    markMacroUse(token) {
        const macro = this.macros.get(token.value);

        if (macro && !token.expanded) {
            this.onMacroUse(macro, token);
        }
    }

    /**
     * Expands all macros in a list of tokens.
     *
     * @param {object[]} tokens
     * @returns {object[]}
     */
    expandLine(tokens) {
        const saved = this.pending;
        const savedLexer = this.lexer;
        const result = [];

        this.pending = tokens.slice();
        this.lexer = { lex: () => undefined };

        let token;
        while ((token = this.raw())) {
            if ((token.type === "name" || token.type === "type") && this.tryExpand(token)) {
                continue;
            }
            result.push(token);
        }

        this.pending = saved;
        this.lexer = savedLexer;

        return result;
    }

    /**
     * Evaluates an #if expression.
     *
     * @returns {boolean}
     */
    evaluate(line, range) {
        // Replace defined(X) and defined X before expanding macros.
        const replaced = [];
        for (let i = 0; i < line.length; i++) {
            const token = line[i];

            if (token.value === "defined") {
                let nameToken = line[i + 1];
                let skip = 1;

                if (nameToken && nameToken.value === "(") {
                    nameToken = line[i + 2];
                    skip = 3;
                }

                if (nameToken) {
                    this.markMacroUse(nameToken);
                }

                const defined = nameToken && this.macros.has(nameToken.value);
                replaced.push({ type: "float", value: defined ? "1" : "0", range: token.range });
                i += skip;
                continue;
            }

            replaced.push(token);
        }

        const tokens = this.expandLine(replaced);
        let index = 0;
        let failed = false;

        const peek = () => tokens[index];
        const take = () => tokens[index++];

        const BINARY = [
            ["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="],
            ["<<", ">>"], ["+", "-"], ["*", "/", "%"]
        ];

        const unary = () => {
            const token = take();

            if (!token) {
                failed = true;
                return 0;
            }

            switch (token.value) {
                case "!": return unary() ? 0 : 1;
                case "-": return -unary();
                case "+": return unary();
                case "~": return ~unary();
                case "(": {
                    const value = ternary();
                    if (!peek() || peek().value !== ")") {
                        failed = true;
                    }
                    take();
                    return value;
                }
            }

            if (token.type === "float") {
                return Number(token.value.replace(/f$/, ""));
            }

            if (token.type === "char") {
                return token.value.charCodeAt(1) || 0;
            }

            // Unknown names are zero, as in C.
            if (token.type === "name" || token.type === "type") {
                return 0;
            }

            if (token.type === "string") {
                return 1;
            }

            failed = true;
            return 0;
        };

        const binary = (level) => {
            if (level >= BINARY.length) {
                return unary();
            }

            let left = binary(level + 1);

            while (peek() && BINARY[level].includes(peek().value)) {
                const op = take().value;
                const right = binary(level + 1);

                switch (op) {
                    case "||": left = (left || right) ? 1 : 0; break;
                    case "&&": left = (left && right) ? 1 : 0; break;
                    case "|": left = left | right; break;
                    case "^": left = left ^ right; break;
                    case "&": left = left & right; break;
                    case "==": left = left === right ? 1 : 0; break;
                    case "!=": left = left !== right ? 1 : 0; break;
                    case "<": left = left < right ? 1 : 0; break;
                    case ">": left = left > right ? 1 : 0; break;
                    case "<=": left = left <= right ? 1 : 0; break;
                    case ">=": left = left >= right ? 1 : 0; break;
                    case "<<": left = left << right; break;
                    case ">>": left = left >> right; break;
                    case "+": left = left + right; break;
                    case "-": left = left - right; break;
                    case "*": left = left * right; break;
                    case "/": left = right ? left / right : 0; break;
                    case "%": left = right ? left % right : 0; break;
                }
            }

            return left;
        };

        const ternary = () => {
            const condition = binary(0);

            if (peek() && peek().value === "?") {
                take();
                const a = ternary();
                if (!peek() || peek().value !== ":") {
                    failed = true;
                    return 0;
                }
                take();
                const b = ternary();
                return condition ? a : b;
            }

            return condition;
        };

        if (tokens.length === 0) {
            this.error("#if with no expression.", range);
            return false;
        }

        const value = ternary();

        if (failed || index < tokens.length) {
            this.error("Invalid #if expression.", range);
            return false;
        }

        return !!value;
    }

    /**
     * Expands the given token if it names a macro.
     *
     * @returns {boolean} True if the token was replaced by an expansion.
     */
    tryExpand(token) {
        const name = token.value;

        if (token.hide && token.hide.has(name)) {
            return false;
        }

        if (DYNAMIC_MACROS.has(name) && !this.macros.has(name)) {
            this.pending.unshift(this.dynamicMacro(token));
            return true;
        }

        const macro = this.macros.get(name);

        if (!macro) {
            return false;
        }

        let args = null;

        if (macro.params) {
            // Function-like macros only expand when followed by '('.
            const open = this.raw();

            if (!open || open.value !== "(") {
                if (open) {
                    this.pending.unshift(open);
                }
                return false;
            }

            args = this.readArguments(token);

            if (!args) {
                return true;
            }
        }

        this.markMacroUse(token);

        const hide = new Set(token.hide || []);
        hide.add(name);

        const result = this.substitute(macro, args, token, hide);
        this.pending.unshift(...result);

        return true;
    }

    /**
     * Reads the arguments of a function-like macro call. The opening '(' has
     * already been consumed.
     *
     * @returns {object[][] | null}
     */
    readArguments(nameToken) {
        const args = [[]];
        let depth = 0;

        while (true) {
            const token = this.raw();

            if (!token) {
                this.error(`Unterminated call to macro '${nameToken.value}'.`, nameToken.range);
                return null;
            }

            if (token.type === "directive") {
                this.readLine();
                continue;
            }

            if (token.type === "eol") {
                continue;
            }

            if (token.value === "(") {
                depth++;
            }
            else if (token.value === ")") {
                if (depth === 0) {
                    break;
                }
                depth--;
            }
            else if (token.value === "," && depth === 0) {
                args.push([]);
                continue;
            }

            args[args.length - 1].push(token);
        }

        if (args.length === 1 && args[0].length === 0) {
            return [];
        }

        return args;
    }

    /**
     * Builds the replacement token list for a macro use.
     */
    substitute(macro, args, nameToken, hide) {
        const params = macro.params || [];
        const used = new Set();
        const result = [];

        if (args) {
            const expected = params.length;
            if (args.length < expected || (!macro.variadic && args.length > expected)) {
                this.error(`Macro '${macro.name}' expects ${macro.variadic ? "at least " : ""}${expected} argument${expected === 1 ? "" : "s"}, got ${args.length}.`, nameToken.range);
            }
        }

        const argumentFor = (name) => {
            if (!args) {
                return null;
            }

            const index = params.indexOf(name);
            if (index >= 0) {
                return args[index] || [];
            }

            if (macro.variadic && name === "__VA_ARGS__") {
                const rest = args.slice(params.length);
                const tokens = [];
                rest.forEach((arg, i) => {
                    if (i > 0) {
                        tokens.push({ type: "operator", value: ",", range: nameToken.range });
                    }
                    tokens.push(...arg);
                });
                return tokens;
            }

            if (macro.variadic && name === "__VA_COUNT__") {
                return [{ type: "float", value: String(Math.max(0, args.length - params.length)), range: nameToken.range }];
            }

            return null;
        };

        const copy = (token, fromArgument) => {
            const copied = Object.assign({}, token);

            // Argument tokens keep their source position the first time they
            // are used so that hover and go-to-definition still work.
            if (fromArgument && !token.expanded && !used.has(token)) {
                used.add(token);
            }
            else {
                copied.range = nameToken.range;
                copied.position = nameToken.range.start;
                copied.expanded = true;
            }

            copied.hide = hide;
            return copied;
        };

        const body = macro.body;

        for (let i = 0; i < body.length; i++) {
            const token = body[i];

            // Stringification: #param
            if (token.value === "#" && args && body[i + 1]) {
                const arg = argumentFor(body[i + 1].value);
                if (arg) {
                    const text = tokensToText(arg).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
                    result.push({ type: "string", value: `"${text}"`, range: nameToken.range, position: nameToken.range.start, expanded: true, hide: hide });
                    i++;
                    continue;
                }
            }

            // Token pasting: a ## b
            if (token.value === "##") {
                const left = result.pop();
                const nextToken = body[i + 1];
                i++;

                if (!nextToken) {
                    if (left) {
                        result.push(left);
                    }
                    continue;
                }

                const rightTokens = argumentFor(nextToken.value) || [nextToken];
                const leftText = left ? left.value : "";
                const rightText = rightTokens.length > 0 ? rightTokens[0].value : "";
                const pasted = lexTokens(leftText + rightText).map((t) => {
                    t.range = nameToken.range;
                    t.position = nameToken.range.start;
                    t.expanded = true;
                    t.hide = hide;
                    return t;
                });

                result.push(...pasted);
                rightTokens.slice(1).forEach((t) => result.push(copy(t, true)));
                continue;
            }

            const arg = (token.type === "name" || token.type === "type") ? argumentFor(token.value) : null;

            if (arg) {
                arg.forEach((t) => result.push(copy(t, true)));
            }
            else {
                result.push(copy(token, false));
            }
        }

        return result;
    }

    /**
     * Produces the token for a predefined dynamic macro such as __LINE__.
     */
    dynamicMacro(token) {
        const make = (type, value) => ({ type: type, value: value, range: token.range, position: token.range.start, expanded: true });
        const now = new Date();

        switch (token.value) {
            case "__LINE__": return make("float", String(token.range.start.line + 1));
            case "__FILE__": return make("string", `"${this.uri.replace(/\\/g, "/").split("/").pop()}"`);
            case "__COUNTER__": return make("float", String(this.counter++));
            case "__COUNTER_LAST__": return make("float", String(Math.max(0, this.counter - 1)));
            case "__RANDOM__": this.random = Math.floor(Math.random() * 256); return make("float", String(this.random));
            case "__RANDOM_LAST__": return make("float", String(this.random));
            case "__DATE__": return make("string", `"${now.toDateString().slice(4)}"`);
            case "__TIME__": return make("string", `"${now.toTimeString().slice(0, 8)}"`);
            default: return make("string", `"${now.toString()}"`);
        }
    }
}

if (typeof require !== 'undefined' && typeof exports !== 'undefined') {
    exports.Preprocessor = Preprocessor;
    exports.Macro = Macro;
    exports.createPredefinedMacros = createPredefinedMacros;
    exports.tokensToText = tokensToText;
}
