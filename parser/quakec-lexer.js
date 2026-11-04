/**
 * @file Tokenizer for QuakeC source, following the rules of the gmqcc lexer.
 *
 * Token types:
 *   name      identifiers and keywords
 *   type      built-in type names (void, int, float, string, entity, vector)
 *   float     numeric constants (decimal, hex, and float forms)
 *   string    "string" constants
 *   char      'c' character constants
 *   vector    '1 2 3' vector constants
 *   operator  operators and punctuation
 *   directive a preprocessor directive name (`#define`); the tokens of the
 *             directive follow and the line ends with an `eol` token
 *   eol       end of a preprocessor directive line
 *   frame     a `$name` frame reference
 *   modelgen  a `$command` line, such as `$frame a b c` (see `args`)
 */

const { Position, Range } = require("./quakec-common");

const TYPE_NAMES = new Set(["void", "int", "float", "string", "entity", "vector"]);

// Longest operators first so that matching is greedy.
const OPERATORS = [
    "...", "<<=", ">>=", "<=>", "&~=",
    "[[", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=",
    "&=", "|=", "^=", "<<", ">>", "><", "**", "##",
    "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "?", ":", ";",
    ",", ".", "(", ")", "[", "]", "{", "}", "#"
];

const NGRAPHS = [
    ["??=", "#"], ["??(", "["], ["??)", "]"], ["??<", "{"], ["??>", "}"], ["??'", "^"],
    ["??!", "|"], ["??-", "~"], ["<:", "["], [":>", "]"], ["<%", "{"], ["%>", "}"], ["%:", "#"]
];

// $commands that are only meaningful to the model and sprite tools. The
// rest of the line is ignored.
const SKIP_LINE_COMMANDS = new Set([
    "cd", "origin", "base", "flags", "scale", "skin", "flush",
    "spritename", "type", "load", "framegroupstart", "framegroupend"
]);

const isIdentStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c > "\x7f";
const isIdent = (c) => isIdentStart(c) || isDigit(c);
const isDigit = (c) => c >= "0" && c <= "9";
const isHexDigit = (c) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isSpace = (c) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v";

const VECTOR_PATTERN = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s+[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s+[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

class QuakeCLexer {
    constructor() {
        this.setInput("");
    }

    /**
     * @param {string} text Source text to tokenize.
     */
    setInput(text) {
        this.text = text || "";
        this.index = 0;
        this.line = 0;
        this.character = 0;
        this.inDirective = false;
        this.atLineStart = true;

        /** Lexical errors, as {message, range}. */
        this.errors = [];
    }

    /**
     * @returns {Position}
     */
    position() {
        return new Position(this.line, this.character);
    }

    peek(offset = 0) {
        return this.text[this.index + offset] || "";
    }

    advance(count = 1) {
        for (let i = 0; i < count && this.index < this.text.length; i++) {
            if (this.text[this.index] === "\n") {
                this.line += 1;
                this.character = 0;
            }
            else {
                this.character += 1;
            }

            this.index += 1;
        }
    }

    error(message, start, end) {
        this.errors.push({ message: message, range: new Range(start, end || this.position()) });
    }

    token(type, value, start, extra) {
        const token = {
            type: type,
            value: value,
            position: start,
            range: new Range(start, this.position())
        };

        return extra ? Object.assign(token, extra) : token;
    }

    /**
     * Skips whitespace and comments. Inside a directive, stops at the end of
     * the line (a backslash before the newline continues the directive).
     *
     * @returns {boolean} True if a directive line ended.
     */
    skipWhitespace() {
        while (this.index < this.text.length) {
            const c = this.peek();

            if (c === "\n") {
                if (this.inDirective) {
                    return true;
                }

                this.atLineStart = true;
                this.advance();
            }
            else if (c === "\\" && this.inDirective && (this.peek(1) === "\n" || (this.peek(1) === "\r" && this.peek(2) === "\n"))) {
                this.advance(this.peek(1) === "\r" ? 3 : 2);
            }
            else if (isSpace(c)) {
                this.advance();
            }
            else if (c === "/" && this.peek(1) === "/") {
                while (this.index < this.text.length && this.peek() !== "\n") {
                    this.advance();
                }
            }
            else if (c === "/" && this.peek(1) === "*") {
                const start = this.position();
                this.advance(2);

                while (this.index < this.text.length && !(this.peek() === "*" && this.peek(1) === "/")) {
                    this.advance();
                }

                if (this.index >= this.text.length) {
                    this.error("Unterminated comment.", start);
                }
                else {
                    this.advance(2);
                }
            }
            else {
                break;
            }
        }

        return this.inDirective && this.index >= this.text.length;
    }

    /**
     * Returns the next token, or undefined at the end of input.
     */
    lex() {
        while (true) {
            const lineEnded = this.skipWhitespace();

            if (lineEnded) {
                this.inDirective = false;
                const at = this.position();
                return this.token("eol", "", at);
            }

            if (this.index >= this.text.length) {
                return undefined;
            }

            const lineStart = this.atLineStart;
            this.atLineStart = false;

            const start = this.position();
            const c = this.peek();

            // Preprocessor directives start a line with '#' followed by a name.
            if (c === "#" && lineStart && !this.inDirective) {
                let offset = 1;
                while (this.peek(offset) === " " || this.peek(offset) === "\t") {
                    offset++;
                }

                if (isIdentStart(this.peek(offset))) {
                    this.advance(offset);
                    const name = this.readIdentifier();
                    this.inDirective = true;
                    return this.token("directive", name, start);
                }
            }

            if (isIdentStart(c)) {
                const name = this.readIdentifier();
                return this.token(TYPE_NAMES.has(name) ? "type" : "name", name, start);
            }

            if (isDigit(c) || (c === "." && isDigit(this.peek(1)))) {
                return this.readNumber(start);
            }

            if (c === "\"") {
                return this.readString(start);
            }

            if (c === "'") {
                return this.readQuoted(start);
            }

            if (c === "$" && !this.inDirective) {
                const token = this.readModelgen(start);
                if (token) {
                    return token;
                }
                continue;
            }

            // Digraphs and trigraphs, which gmqcc also accepts.
            const graph = NGRAPHS.find((g) => this.text.startsWith(g[0], this.index));
            if (graph) {
                this.advance(graph[0].length);
                return this.token("operator", graph[1], start);
            }

            for (const op of OPERATORS) {
                if (this.text.startsWith(op, this.index)) {
                    // '##' only means token pasting inside a directive.
                    if (op === "##" && !this.inDirective) {
                        continue;
                    }

                    this.advance(op.length);
                    return this.token("operator", op, start);
                }
            }

            this.advance();
            this.error(`Unexpected character: '${c}'`, start);
        }
    }

    readIdentifier() {
        let value = "";

        while (this.index < this.text.length && isIdent(this.peek())) {
            value += this.peek();
            this.advance();
        }

        return value;
    }

    readNumber(start) {
        let value = "";
        let isFloat = false;

        if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
            value = this.peek() + this.peek(1);
            this.advance(2);

            while (isHexDigit(this.peek())) {
                value += this.peek();
                this.advance();
            }
        }
        else {
            while (isDigit(this.peek())) {
                value += this.peek();
                this.advance();
            }

            // Don't eat the first dot of a '...' token.
            if (this.peek() === "." && !(this.peek(1) === "." && this.peek(2) === ".")) {
                isFloat = true;
                value += ".";
                this.advance();

                while (isDigit(this.peek())) {
                    value += this.peek();
                    this.advance();
                }
            }

            if (isFloat && this.peek() === "f") {
                value += "f";
                this.advance();
            }
        }

        if (isIdent(this.peek())) {
            const errorStart = this.position();
            while (isIdent(this.peek())) {
                this.advance();
            }
            this.error("Unexpected trailing characters after number.", errorStart);
        }

        return this.token("float", value, start);
    }

    readString(start) {
        let value = "\"";
        this.advance();

        while (this.index < this.text.length) {
            const c = this.peek();

            if (c === "\\") {
                value += c + this.peek(1);
                this.advance(2);
                continue;
            }

            if (c === "\"") {
                value += c;
                this.advance();
                return this.token("string", value, start);
            }

            // gmqcc allows strings to span lines.

            value += c;
            this.advance();
        }

        this.error("Unterminated string.", start);
        return this.token("string", value + "\"", start);
    }

    readQuoted(start) {
        let value = "'";
        this.advance();

        while (this.index < this.text.length) {
            const c = this.peek();

            if (c === "\\") {
                value += c + this.peek(1);
                this.advance(2);
                continue;
            }

            if (c === "'") {
                value += c;
                this.advance();
                const inner = value.slice(1, -1);
                return this.token(VECTOR_PATTERN.test(inner) ? "vector" : "char", value, start);
            }

            if (c === "\n") {
                break;
            }

            value += c;
            this.advance();
        }

        this.error("Unterminated character or vector constant.", start);
        return this.token("char", value + "'", start);
    }

    /**
     * Reads the rest of the current line as whitespace separated words.
     *
     * @returns {{value: string, range: Range}[]}
     */
    readLineWords() {
        const words = [];

        while (this.index < this.text.length && this.peek() !== "\n") {
            const c = this.peek();

            if (c === "/" && (this.peek(1) === "/" || this.peek(1) === "*")) {
                if (this.peek(1) === "/") {
                    break;
                }

                // Block comments inside a $ line are skipped.
                this.advance(2);
                while (this.index < this.text.length && !(this.peek() === "*" && this.peek(1) === "/")) {
                    this.advance();
                }
                this.advance(2);
                continue;
            }

            if (isSpace(c)) {
                this.advance();
                continue;
            }

            const start = this.position();
            let word = "";
            while (this.index < this.text.length && !isSpace(this.peek()) && !(this.peek() === "/" && (this.peek(1) === "/" || this.peek(1) === "*"))) {
                word += this.peek();
                this.advance();
            }
            words.push({ value: word, range: new Range(start, this.position()) });
        }

        return words;
    }

    /**
     * Handles `$` model generation commands and `$name` frame references.
     */
    readModelgen(start) {
        this.advance();

        if (!isIdentStart(this.peek())) {
            this.error("Hanging '$' modelgen/spritegen command.", start);
            return null;
        }

        const name = this.readIdentifier();
        const nameRange = new Range(start, this.position());

        if (name === "frame" || name === "framesave" || name === "framevalue" || name === "framerestore" || name === "modelname") {
            const args = this.readLineWords();
            return this.token("modelgen", name, start, { args: args, nameRange: nameRange });
        }

        if (SKIP_LINE_COMMANDS.has(name)) {
            const args = this.readLineWords();
            return this.token("modelgen", name, start, { args: args, nameRange: nameRange });
        }

        return this.token("frame", name, start);
    }
}

const OPERATOR_SET = new Set(OPERATORS);

if (typeof require !== 'undefined' && typeof exports !== 'undefined') {
    exports.Lexer = function() {
        return new QuakeCLexer();
    };
    exports.QuakeCLexer = QuakeCLexer;
    exports.TYPE_NAMES = TYPE_NAMES;
    exports.OPERATORS = OPERATOR_SET;
}
