const assert = require("assert");
const Lexer = require("../quakec-lexer").Lexer;

describe("Lexer", function() {
    const all = function(program) {
        const lexer = Lexer();
        lexer.setInput(program);

        const result = [];
        let token = lexer.lex();

        while (token) {
            result.push(token);
            token = lexer.lex();
        }

        result.errors = lexer.errors;
        return result;
    };

    // Compact form of a token list: "type:value" strings.
    const summary = function(program) {
        return all(program).map((t) => `${t.type}:${t.value}`);
    };

    describe("Literals", function() {
        it("Should handle floats", function() {
            assert.deepStrictEqual(summary("1.234 1. .5 10 0x1F 2.5f"), [
                "float:1.234", "float:1.", "float:.5", "float:10", "float:0x1F", "float:2.5f"
            ]);
        });
        it("Should lex a negative number as an operator and a number", function() {
            assert.deepStrictEqual(summary("-1.234"), ["operator:-", "float:1.234"]);
        });
        it("Should report trailing characters after a number", function() {
            const tokens = all("12abc");
            assert.strictEqual(tokens.errors.length, 1);
        });
        it("Should handle vectors", function() {
            assert.deepStrictEqual(summary("'1.234 0 -4' ' 0 0 0 '"), ["vector:'1.234 0 -4'", "vector:' 0 0 0 '"]);
        });
        it("Should handle character constants", function() {
            assert.deepStrictEqual(summary("'a' '\\n'"), ["char:'a'", "char:'\\n'"]);
        });
        it("Should handle strings", function() {
            assert.deepStrictEqual(summary(`"hello world!" "maps/jrwiz1.bsp" "say \\"hi\\""`), [
                `string:"hello world!"`, `string:"maps/jrwiz1.bsp"`, `string:"say \\"hi\\""`
            ]);
        });
        it("Should handle strings that span lines", function() {
            const tokens = all(`"\nhello world!\n" x`);
            assert.strictEqual(tokens[0].type, "string");
            assert.strictEqual(tokens[1].range.start.line, 2);
        });
        it("Should report unterminated strings", function() {
            const tokens = all(`"hello`);
            assert.strictEqual(tokens.errors.length, 1);
        });
    });

    describe("Names", function() {
        it("Should separate type names from other names", function() {
            assert.deepStrictEqual(summary("void int float string entity vector const foo _bar2"), [
                "type:void", "type:int", "type:float", "type:string", "type:entity", "type:vector",
                "name:const", "name:foo", "name:_bar2"
            ]);
        });
        it("Should handle field types as separate tokens", function() {
            assert.deepStrictEqual(summary(".float ..vector"), ["operator:.", "type:float", "operator:.", "operator:.", "type:vector"]);
        });
    });

    describe("Operators", function() {
        it("Should handle all operators", function() {
            const operators = [
                "...", "<<=", ">>=", "<=>", "&~=", "[[", "==", "!=", "<=", ">=", "&&", "||", "++", "--",
                "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "><", "**",
                "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "?", ":", ";",
                ",", ".", "(", ")", "[", "]", "{", "}", "#"
            ];
            assert.deepStrictEqual(summary(operators.join(" ")), operators.map((op) => `operator:${op}`));
        });
        it("Should handle builtin numbers", function() {
            assert.deepStrictEqual(summary("#1 #22"), ["operator:#", "float:1", "operator:#", "float:22"]);
        });
        it("Should handle digraphs and trigraphs", function() {
            assert.deepStrictEqual(summary("<: :> <% %> ??( ??)"), [
                "operator:[", "operator:]", "operator:{", "operator:}", "operator:[", "operator:]"
            ]);
        });
    });

    describe("Positions", function() {
        it("Should track lines and characters", function() {
            const tokens = all("float a;\n  a = 1;");
            const a = tokens[3];
            assert.strictEqual(a.value, "a");
            assert.strictEqual(a.position.line, 1);
            assert.strictEqual(a.position.character, 2);
            assert.strictEqual(a.range.end.character, 3);
        });
    });

    describe("Comments", function() {
        it("Should skip line and block comments", function() {
            assert.deepStrictEqual(summary("a // comment\n/* block\ncomment */ b"), ["name:a", "name:b"]);
        });
        it("Should report unterminated block comments", function() {
            assert.strictEqual(all("/* never closed").errors.length, 1);
        });
    });

    describe("Preprocessor", function() {
        it("Should lex directives and end them at the end of the line", function() {
            assert.deepStrictEqual(summary("#define FOO 1\nfloat"), [
                "directive:define", "name:FOO", "float:1", "eol:", "type:float"
            ]);
        });
        it("Should allow whitespace between '#' and the directive name", function() {
            assert.deepStrictEqual(summary("  #  ifdef FOO\n"), ["directive:ifdef", "name:FOO", "eol:"]);
        });
        it("Should continue directives over escaped newlines", function() {
            assert.deepStrictEqual(summary("#define FOO \\\n 1\nx"), [
                "directive:define", "name:FOO", "float:1", "eol:", "name:x"
            ]);
        });
        it("Should only treat '##' as one token inside directives", function() {
            assert.deepStrictEqual(summary("#define CAT(a, b) a ## b\n"), [
                "directive:define", "name:CAT", "operator:(", "name:a", "operator:,", "name:b", "operator:)",
                "name:a", "operator:##", "name:b", "eol:"
            ]);
        });
    });

    describe("Model generation commands", function() {
        it("Should handle frame definitions", function() {
            const tokens = all("$frame stand1 stand2\nfloat");
            assert.strictEqual(tokens[0].type, "modelgen");
            assert.strictEqual(tokens[0].value, "frame");
            assert.deepStrictEqual(tokens[0].args.map((a) => a.value), ["stand1", "stand2"]);
            assert.strictEqual(tokens[1].value, "float");
        });
        for (const command of ["modelname", "spritename", "type", "load", "cd", "flags", "origin", "scale", "base", "skin", "framegroupstart", "framegroupend"]) {
            it(`Should consume the rest of a $${command} line`, function() {
                const tokens = all(`$${command} some thing\nfloat`);
                assert.strictEqual(tokens.length, 2);
                assert.strictEqual(tokens[0].type, "modelgen");
                assert.strictEqual(tokens[1].value, "float");
            });
        }
        it("Should handle frame references", function() {
            assert.deepStrictEqual(summary("$stand1"), ["frame:stand1"]);
        });
    });
});
