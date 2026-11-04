const assert = require("assert");
const qparse = require("../quakec-parser").parse;

const parse = function(program) {
    return qparse({ program: program });
};

describe("Parser", function() {
    assert.noErrors = function(program) {
        assert.equal(0, program.errors.length, "Parse errors occurred.");
    };

    assert.rangesEqual = function(actual, expected) {
        assert.equal(actual.start.line, expected.start.line, "Starting line numbers should be equal.");
        assert.equal(actual.start.character, expected.start.character, "Starting character numbers should be equal.");
        assert.equal(actual.end.line, expected.end.line, "Ending line numbers should be equal.");
        assert.equal(actual.start.character, expected.start.character, "Ending line numbers should be equal.");
    };

    assert.errorsEqual = function(actual, expected) {
        assert.equal(actual.severity, expected.severity, "Error severities should be equal.");
        assert.equal(actual.message, expected.message, "Error messages should be equal.");
        assert.rangesEqual(actual.range, expected.range, "Error ranges should be equal.");
    };

    describe("Definitions", function() {
        describe("Simple Types", function() {
            it("Should be able to define a float", function() {
                const program = `float time;`;
                const actual = parse(program);
                assert.noErrors(actual);

                const definition = actual.scope.def["time"];
                assert.equal(definition.value, "time");
            });
            it("Should be able to init a float", function() {
                const program = `float time = 0.0;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to init a negative float", function() {
                const program = `float NEGATIVE = -1.0;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a vector", function() {
                const program = `vector position;`;
                const actual = parse(program);
                assert.noErrors(actual);
                const scope = actual.scope;
                const xComponent = scope.find("position_x");
                const yComponent = scope.find("position_y");
                const zComponent = scope.find("position_z");
                assert.equal(!!xComponent, true, "Accessor for x-component should be defined.");
                assert.equal(!!yComponent, true, "Accessor for y-component should be defined.");
                assert.equal(!!zComponent, true, "Accessor for z-component should be defined.");
                assert.equal(xComponent.type.value, "float", "Accessor should be of type float.");
                assert.equal(yComponent.type.value, "float", "Accessor should be of type float.");
                assert.equal(zComponent.type.value, "float", "Accessor should be of type float.");
            });
            it("Should be able to init a vector", function() {
                const program = `vector position ='1.0 0 -2.0';`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a string", function() {
                const program = `string message;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to init a string", function() {
                const program = `string message = "hello world!\n";`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define an entity", function() {
                const program = `entity target;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define multiple variables", function() {
                const program = `float parm1, parm2, parm3;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to initialize multiple variables", function() {
                const program = `float parm1, parm2, parm3 = 0;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
        describe("Field Types", function() {
            it("Should be able to define a .float", function() {
                const program = `.float time;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to init a .float", function() {
                const program = `.float time = 0.0;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a .vector", function() {
                const program = `.vector position;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to init a .vector", function() {
                const program = `.vector position ='1.0 0 -2.0';`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a .string", function() {
                const program = `.string message;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to init a .string", function() {
                const program = `.string message = "hello world!\n";`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define an .entity", function() {
                const program = `.entity target;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
        describe("Function Types", function() {
            it("Should be able to forward declare a function", function() {
                const program = `void() update;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to forward declare a function that takes simple args", function() {
                const program = `void(entity target) update;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to forward declare a function that takes function args", function() {
                const program = `void(entity target, void() callback) update;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a function", function() {
                const program = `void() update = {float time = 0.0;};`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a function via a builtin", function() {
                const program = `void(vector ang)	makevectors = #1;`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should not define accessors for functions of type vector", function() {
                const program = `vector(entity target) lookAt;`;
                const actual = parse(program);
                assert.noErrors(actual);
                const scope = actual.scope;
                const xComponent = scope.find("lookAt_x");
                const yComponent = scope.find("lookAt_y");
                const zComponent = scope.find("lookAt_z");
                assert.strictEqual(xComponent, null, "Accessor should not be defined.");
                assert.strictEqual(yComponent, null, "Accessor should not be defined.");
                assert.strictEqual(zComponent, null, "Accessor should not be defined.");
            });
        });
        describe("Frames", function() {
            it("Should be able to define frames", function() {
                const program = `$frame frame1 frame2 frame3`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a frame with optional value", function() {
                const program = `$frame frame1 1.0`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a frame function", function() {
                const program = `$frame frame1\nvoid() nextthink;\nvoid() framename = [$frame1, nextthink] {};`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to define a frame function with float literal", function() {
                const program = `void() framename = [0, nextthink] {};`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to start frame groups", function() {
                const program = `$framegroupstart`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should be able to end frame groups", function() {
                const program = `$framegroupend`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
    });
    describe("Statements", function() {
        describe("Conditional", function() {
            it("Should handle if statements", function() {
                const program = `
                void() test = {
                    float i = 10;
                    if (i > 0)
                        i = 0;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle block if statements", function() {
                const program = `
                void() test = {
                    float i = 10;
                    if (i > 0) {
                        i = 0;
                    }
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle if else statements", function() {
                const program = `
                void() test = {
                    float i = 10;
                    if (i > 0) {
                        i = 0;
                    }
                    else {
                        i = i + 1;
                    }
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle nested if else statements", function() {
                const program = `
                void() test = {
                    float i = 10;
                    if (i > 0) {
                        if (i < 100) {
                            i = 0;
                        }
                    }
                    else {
                        i = i + 1;
                    }
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
        describe("Control", function() {
            it("Should handle do loops", function() {
                const program = `
                float i = 0;
                void() test = {
                    do
                        i = i - 1;
                    while (i < 10);
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle block do loops", function() {
                const program = `
                float i = 0;
                void() test = {
                    do {
                        i = i - 1;
                    }
                    while (i < 10);
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle while loops", function() {
                const program = `
                float i = 0;
                void() func = {
                    while (i < 10)
                        i = i - 1;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle block while loops", function() {
                const program = `
                float i = 0;
                void() func = {
                    while (i < 10) {
                        i = i - 1;
                    }
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
        describe("Function Invocation", function() {
            it("Should handle invocation with no parameters", function() {
                const program = `
                void() test = {
                    test();
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle invocation with parameters", function() {
                const program = `
                void(float time) test = {
                    float a = 0;
                    test(a - 1);
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should have function parameters defined in local scope", function() {
                const program = `
                float(float time) test = {
                    return time + 1;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle invocation on fields", function() {
                const program = `
                void() test = {
                    self.th_walk();
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
        describe("Return", function() {
            it("Should handle return statements", function() {
                const program = `
                void() test = {
                    return;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle return statements with value", function() {
                const program = `
                float() test = {
                    return 42;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
        describe("Local Variables", function() {
            it("Should handle defining local variables", function() {
                const program = `
                void() test = {
                    local float time;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle defining multiple local variables", function() {
                const program = `
                void() test = {
                    local float time, counter;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle initializing local variables", function() {
                const program = `
                void() test = {
                    local float time = 0.0;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle local variable assignment", function() {
                const program = `
                float(float v) test = {
                    v = v - 360;
                    return v;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
    });
    describe("Expressions", function() {
        describe("Infix", function() {
            it("Should handle the && operator", function() {
                const program = `
                void() test = {
                    1 && 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the || operator", function() {
                const program = `
                void() test = {
                    1 || 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the <= operator", function() {
                const program = `
                void() test = {
                    1 <= 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the >= operator", function() {
                const program = `
                void() test = {
                    1 >= 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the == operator", function() {
                const program = `
                void() test = {
                    1 == 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the != operator", function() {
                const program = `
                void() test = {
                    1 != 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the * operator", function() {
                const program = `
                void() test = {
                    1 * 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the / operator", function() {
                const program = `
                void() test = {
                    1 / 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the - operator", function() {
                const program = `
                void() test = {
                    1 - 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the + operator", function() {
                const program = `
                void() test = {
                    1 + 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the = operator", function() {
                const program = `
                void() test = {
                    local float t;
                    t = 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle = on fields", function() {
                const program = `
                void() test = {
                    self.solid = 0;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the < operator", function() {
                const program = `
                void() test = {
                    1 < 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the > operator", function() {
                const program = `
                void() test = {
                    1 > 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the & operator", function() {
                const program = `
                void() test = {
                    1 & 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the | operator", function() {
                const program = `
                void() test = {
                    1 | 2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
        describe("Prefix", function() {
            it("Should handle the ! operator", function() {
                const program = `
                void() test = {
                    !1;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the - operator", function() {
                const program = `
                void() test = {
                    -2;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the ( operator", function() {
                const program = `
                void() test = {
                    (0);
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
            it("Should handle the $ operator", function() {
                const program = `
                $frame frame1
                void() test = {
                    float a = $frame1;
                };`;
                const actual = parse(program);
                assert.noErrors(actual);
            });
        });
    });
    describe("gmqcc", function() {
        const errorsOf = function(program, language) {
            return qparse({ program: program, language: language }).errors.filter((e) => e.severity === 1);
        };

        assert.parses = function(program, language) {
            const errors = errorsOf(program, language);
            assert.deepStrictEqual(errors.map((e) => `${e.range.start.line}:${e.range.start.character} ${e.message}`), []);
        };

        it("Should handle const, var, and noref", function() {
            assert.parses(`
            const float SPEED = 320;
            var float counter = 0;
            noref float unused;
            const vector UP = '0 0 1';`);
        });
        it("Should handle C-style functions and prototypes", function() {
            assert.parses(`
            float add(float a, float b);
            float add(float a, float b) { return a + b; }
            void touch() { add(1, 2); };
            float(float x) square = { return x * x; };`);
        });
        it("Should handle builtins with C-style syntax", function() {
            assert.parses(`
            void print(string s, ...) = #1;
            string ftos(float f) = #2;`);
        });
        it("Should handle arrays", function() {
            assert.parses(`
            float list[4];
            float init[3] = { 1, 2, 3 };
            .float fields[2];
            void test() {
                float local_list[2];
                local_list[0] = list[1] + init[2];
                entity e;
                e.fields[1] = 2;
            }`);
        });
        it("Should handle loops and switches", function() {
            assert.parses(`
            void test() {
                float i, total;
                for (i = 0; i < 10; ++i) { total += i; }
                for (float j = 0; j < 3; j++) continue;
                for (;;) break;
                do { i--; } while (i > 0);
                while :outer (1) { break outer; }
                switch (i) {
                    case 0:
                    case 1: total = 1; break;
                    default: total = 2;
                }
            }`);
        });
        it("Should handle 'if not'", function() {
            assert.parses(`void test() { float a; if not (a) a = 1; else a = 2; }`);
        });
        it("Should handle operators", function() {
            assert.parses(`
            void test() {
                float a, b, c;
                vector v, w;
                a = b ? c : 1;
                a += 1; a -= 1; a *= 2; a /= 2; a %= 3; a |= 4; a &= 4; a ^= 1; a <<= 1; a >>= 1; a &~= 2;
                a = b % c; a = b ^ c; a = ~b; a = b << 2; a = b >> 2; a = b ** 2; a = b <=> c;
                v = v >< w;
                a = -b; a = +b; a = !b;
                a++; ++a; a--; --a;
                a = (b, c);
            }`);
        });
        it("Should handle typedefs", function() {
            assert.parses(`
            typedef float number;
            typedef void(entity e) callback;
            number count;
            callback on_touch;
            void test() {
                typedef string text;
                text name = "x";
                number n = count;
            }`);
        });
        it("Should handle enums", function() {
            const program = qparse({ program: `
            enum { A, B, C = 10, D };
            enum : flag { F1, F2, F3 };
            enum : reverse { R1, R2, R3 };
            float x = A + D;` });
            assert.noErrors(program);
            const value = (name) => program.scope.find(name).initializer;
            assert.deepStrictEqual(["A", "B", "C", "D"].map(value), ["0", "1", "10", "11"]);
            assert.deepStrictEqual(["F1", "F2", "F3"].map(value), ["2", "4", "8"]);
            assert.deepStrictEqual(["R1", "R2", "R3"].map(value), ["2", "1", "0"]);
        });
        it("Should handle variable arguments", function() {
            assert.parses(`
            void print(...) = #1;
            void show(float a, string... count) {
                float i;
                for (i = 0; i < count; ++i)
                    print(...(i, string));
            }
            void any(float a, ...) {}`);
        });
        it("Should handle goto and labels", function() {
            assert.parses(`
            void test() {
                float x;
                goto done;
                :again
                x = 1;
                goto (x == 1) ? done : again;
                :done
            }`);
        });
        it("Should handle attributes", function() {
            assert.parses(`
            [[noreturn]] void error(string s) = #10;
            [[deprecated("use other")]] void old() {}
            [[alias("old")]] void old_alias();
            [[accumulate]] void hook() { }
            [[accumulate]] void hook() { }`);
        });
        it("Should handle other literals and names", function() {
            assert.parses(`
            int i = 5;
            float hex = 0x10;
            float character = 'a';
            string joined = "a" "b"
                "c";
            void test() {
                entity e = nil;
                string name = __FUNC__;
            }`);
        });
        it("Should handle field and function pointer types", function() {
            assert.parses(`
            .void() think;
            .float(entity other) evaluate;
            ..float pointer_to_field;
            float(float(float) f, float x) apply = { return f(x); };
            void test() {
                entity e;
                .float which = health;
                e.think();
                e.(which) = 1;
            }
            .float health;`);
        });
        it("Should handle old-style local declarations", function() {
            assert.parses(`void() test = { local float a; local vector v = '1 2 3'; a = v_x + v.y; };`);
        });
        it("Should accept the 'break' builtin from id's defs.qc with a warning", function() {
            const program = qparse({ program: `void(entity e) break = #6;` });
            assert.strictEqual(program.errors.length, 1);
            assert.strictEqual(program.errors[0].severity, 2);
        });
        it("Should handle return assignments", function() {
            assert.parses(`float test() { return = 5; }`);
        });
        it("Should handle state functions", function() {
            assert.parses(`
            $frame stand1 stand2
            void() stand2;
            void() stand1 = [$stand1, stand2] { };
            void() stand2 = [$stand2, stand1] { self.frame = $stand1; };
            entity self;
            .float frame;`);
        });
    });
    describe("Preprocessor", function() {
        it("Should expand object-like macros", function() {
            const program = qparse({ program: `
            #define SIZE 4
            float list[SIZE];` });
            assert.noErrors(program);
        });
        it("Should expand function-like macros into statements", function() {
            const program = qparse({ program: `
            #define CHECK(x) if (!(x)) { return; }
            void test(float a) { CHECK(a) a = 1; }` });
            assert.noErrors(program);
        });
        it("Should skip inactive blocks", function() {
            const program = qparse({ program: `
            #define FEATURE
            #ifdef FEATURE
            float enabled;
            #else
            this is not valid code
            #endif
            #if defined(FEATURE) && !defined(OTHER)
            float also;
            #elif 1
            more invalid code
            #endif` });
            assert.noErrors(program);
            assert.strictEqual(program.inactiveRanges.length, 2);
            assert.ok(program.scope.find("enabled"));
        });
        it("Should report #error", function() {
            const program = qparse({ program: `#error stop here\n` });
            assert.strictEqual(program.errors.length, 1);
            assert.ok(program.errors[0].message.includes("stop here"));
        });
        it("Should report an unterminated #if", function() {
            const program = qparse({ program: `#ifdef A\nfloat x;\n` });
            assert.strictEqual(program.errors.length, 1);
        });
        it("Should carry macros from one document to the next", function() {
            const first = qparse({ program: `#define DAMAGE 10\n`, uri: "a.qc" });
            const second = qparse({ program: `float d = DAMAGE;`, uri: "b.qc", macros: first.macros, parentScope: first.scope });
            assert.noErrors(second);
            const definition = second.getSymbolDefinition({ line: 0, character: 12 });
            assert.strictEqual(definition.kind, "macro");
            assert.strictEqual(definition.uri, "a.qc");
            assert.strictEqual(second.getTypeString({ line: 0, character: 12 }), "#define DAMAGE 10");
        });
        it("Should bring in definitions with #include", function() {
            const header = qparse({ program: `#define LIMIT 2\nfloat shared;`, uri: "defs.qh" });
            const program = qparse({
                program: `#include "defs.qh"\nfloat x = LIMIT;\nvoid test() { shared = x; }`,
                uri: "main.qc",
                include: (path) => path === "defs.qh" ? { scope: header.scope, macros: header.macros } : null
            });
            assert.noErrors(program);
            assert.strictEqual(program.getSymbolDefinition({ line: 2, character: 15 }).uri, "defs.qh");
        });
        it("Should warn about missing includes", function() {
            const program = qparse({ program: `#include "missing.qh"\n`, include: () => null });
            assert.strictEqual(program.errors.length, 1);
            assert.strictEqual(program.errors[0].severity, 2);
        });
    });
    describe("Errors", function() {
        const errors = function(program, language) {
            return qparse({ program: program, language: language }).errors;
        };

        it("Should handle undefined names", function() {
            const program = `
            void() test = {
                onerror();
            };`;
            const actual = parse(program);
            assert.noErrors(actual);
        });
        it("Should report missing semicolons", function() {
            const actual = errors(`float a\nfloat b;`);
            assert.strictEqual(actual.length, 1);
            assert.ok(actual[0].message.includes("Missing semicolon"));
            assert.strictEqual(actual[0].range.start.line, 0);
        });
        it("Should report functions with two bodies", function() {
            const actual = errors(`void f() {}\nvoid f() {}`);
            assert.strictEqual(actual.length, 1);
            assert.strictEqual(actual[0].severity, 1);
        });
        it("Should report duplicate locals but allow shadowing in nested blocks", function() {
            assert.strictEqual(errors(`void f() { float a; { float a; } }`).length, 0);
            assert.strictEqual(errors(`void f() { float a; float a; }`).length, 1);
        });
        it("Should warn about duplicate globals", function() {
            const actual = errors(`float a;\nfloat a;`);
            assert.strictEqual(actual.length, 1);
            assert.strictEqual(actual[0].severity, 2);
        });
        it("Should report redeclaring a [[last]] global", function() {
            assert.strictEqual(errors(`float a;\n[[last]] float a;`).length, 0);
            assert.strictEqual(errors(`[[last]] float a;\nfloat a;`).length, 1);
        });
        it("Should report stray semicolons at file scope", function() {
            assert.strictEqual(errors(`;`).length, 1);
        });
        it("Should report break and continue outside of loops", function() {
            assert.strictEqual(errors(`void f() { break; }`).length, 1);
            assert.strictEqual(errors(`void f() { switch (1) { default: continue; } }`).length, 1);
        });
        it("Should report undefined labels", function() {
            assert.strictEqual(errors(`void f() { goto nowhere; }`).length, 1);
        });
        it("Should report unknown frame macros", function() {
            assert.strictEqual(errors(`void f() { float a = $nope; }`).length, 1);
        });
        it("Should report one error per broken statement and keep going", function() {
            const actual = errors(`
            void f() {
                float a = ;
                a = 1;
            }
            void g() {
                ) junk (;
            }
            float ok;`);
            assert.strictEqual(actual.length, 2);
            assert.deepStrictEqual(actual.map((e) => e.range.start.line), [2, 6]);
        });
        it("Should report a missing closing brace", function() {
            assert.strictEqual(errors(`void f() {\nfloat a;\n`).length, 1);
        });
        it("Should report 'static' at file scope", function() {
            assert.strictEqual(errors(`static float a;`).length, 1);
        });
        it("Should never throw on garbage input", function() {
            const inputs = ["{{{{", "}}}}", "((((", "float (", "void() f = {", "#define", "#if", "[[", "$", "'1 2", "\"", "...", "enum {", "typedef"];
            for (const input of inputs) {
                const actual = errors(input);
                assert.ok(actual.every((e) => !e.message.includes("fatal")), input);
            }
        });
    });
    describe("Language standards", function() {
        const errors = function(program, language) {
            return qparse({ program: program, language: language }).errors;
        };

        it("Should label diagnostics with the language", function() {
            assert.ok(errors(`;`, "fteqcc")[0].message.startsWith("[fteqcc]"));
        });
        it("Should reject C-style functions with -std=qcc", function() {
            assert.ok(errors(`void f() {};`, "qcc").length > 0);
            assert.strictEqual(errors(`void() f = {};`, "qcc").length, 0);
        });
        it("Should require a semicolon after function bodies with -std=qcc", function() {
            assert.strictEqual(errors(`void() f = {}`, "qcc").length, 1);
            assert.strictEqual(errors(`void() f = {}`, "gmqcc").length, 0);
        });
        it("Should reject newer operators with -std=qcc", function() {
            assert.strictEqual(errors(`void() f = { local float a; a++; };`, "qcc").length, 1);
        });
        it("Should allow gmqcc keywords as names with -std=qcc", function() {
            assert.strictEqual(errors(`float switch;`, "qcc").length, 0);
            assert.strictEqual(errors(`float switch;`, "gmqcc").length, 1);
        });
        it("Should allow arrays with every standard", function() {
            for (const language of ["qcc", "fteqcc", "gmqcc"]) {
                assert.strictEqual(errors(`float list[3];`, language).length, 0, language);
            }
        });
    });
    describe("Symbols", function() {
        const at = (line, character) => ({ line: line, character: character });

        it("Should describe functions", function() {
            const program = qparse({ program: `void(entity e, float(float) f) touch;\nvoid run(float speed, ...) {}` });
            assert.strictEqual(program.getTypeString(at(0, 33)), "void(entity e, float(float) f) touch");
            assert.strictEqual(program.getTypeString(at(1, 6)), "void(float speed, ...) run");
        });
        it("Should describe constants with their values", function() {
            const program = qparse({ program: `const float SPEED = -320;\nconst string NAME = "hi";` });
            assert.strictEqual(program.getTypeString(at(0, 13)), "const float SPEED = -320");
            assert.strictEqual(program.getTypeString(at(1, 14)), `const string NAME = "hi"`);
        });
        it("Should describe fields and arrays", function() {
            const program = qparse({ program: `.float health;\nfloat list[4];\n.vector origin;` });
            assert.strictEqual(program.getTypeString(at(0, 8)), ".float health");
            assert.strictEqual(program.getTypeString(at(1, 7)), "float list[4]");
            assert.strictEqual(program.scope.find("origin_x").type.value, ".float");
        });
        it("Should find the definition of a field used on an entity", function() {
            const program = qparse({ program: `.float health;\nentity self;\nvoid f() { self.health = 1; }` });
            const location = program.getDefinition(at(2, 18));
            assert.strictEqual(location.range.start.line, 0);
            assert.strictEqual(location.range.start.character, 7);
        });
        it("Should scope C-style parameters to the function body", function() {
            const program = qparse({ program: `float speed;\nvoid f(float speed) { speed = 1; }\nvoid g() { speed = 2; }` });
            assert.strictEqual(program.getSymbolDefinition(at(1, 22)).kind, "parameter");
            assert.strictEqual(program.getSymbolDefinition(at(2, 11)).kind, "variable");
        });
        it("Should point to the function body rather than the prototype", function() {
            const program = qparse({ program: `void() f;\nvoid() g = { f(); };\nvoid() f = {};\nvoid() h = { f(); };` });
            assert.strictEqual(program.getDefinition(at(3, 13)).range.start.line, 2);
        });
        it("Should link a prototype in one file to its body in another", function() {
            const first = qparse({ program: `void() f;`, uri: "a.qc" });
            const second = qparse({ program: `void() f = {};`, uri: "b.qc", parentScope: first.scope });
            const prototype = first.getSymbolDefinition(at(0, 7));
            const body = second.getSymbolDefinition(at(0, 7));
            assert.notStrictEqual(prototype, body);
            assert.strictEqual(body.canonical, prototype);
            assert.strictEqual(second.errors.length, 0);
        });
        it("Should resolve labels", function() {
            const program = qparse({ program: `void f() {\ngoto end;\n:end\n}` });
            assert.strictEqual(program.getDefinition(at(1, 6)).range.start.line, 2);
        });
        it("Should describe frames", function() {
            const program = qparse({ program: `$frame stand1 stand2\nfloat f = $stand2;` });
            assert.strictEqual(program.getTypeString(at(1, 11)), "$frame stand2 = 1");
        });
    });
});
