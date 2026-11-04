/**
 * @file Common classes for working with language source documents
 * @author Joshua Skelton
 */

const fs = require("fs");
const path = require("path");
const url = require("url");
const parser = require("../../parser/quakec-parser");
const { Macro } = require("../../parser/quakec-preprocessor");
const { Lexer } = require("../../parser/quakec-lexer");
const { TextDocument } = require('vscode-languageserver-textdocument');

/** @typedef {import('vscode-languageserver').Diagnostic} Diagnostic*/
/** @typedef {import('vscode-languageserver').Hover} Hover*/
/** @typedef {import('vscode-languageserver').Location} Location*/
/** @typedef {import('vscode-languageserver').PublishDiagnosticsParams} PublishDiagnosticsParams*/
/** @typedef {import('vscode-languageserver').ReferenceParams} ReferenceParams*/
/** @typedef {import('vscode-languageserver').TextDocumentPositionParams} TextDocumentPositionParams*/
/** @typedef {import('../../parser/quakec-parser').Program} Program */
/** @typedef {import('../../parser/quakec-parser').Scope} Scope */

/** Language standards, matching gmqcc's -std flag. */
const LANGUAGES = ["gmqcc", "fteqcc", "qcc"];
const DEFAULT_LANGUAGE = "gmqcc";

/** Folders that never hold QuakeC sources worth scanning. */
const SKIPPED_FOLDERS = new Set([".git", ".hg", ".svn", "node_modules", ".vscode-test"]);

class DocumentCacheItem {
    /**
     * @param {number} version Document version.
     * @param {TextDocument} document TextDocument
     * @param {string} uri Normalized path of the document.
     */
    constructor(version, document, uri) {
        /** @type {number} */
        this.version = version || -1;

        /** @type {TextDocument} */
        this.document = document || null;

        /** @type {string} */
        this.uri = uri;
    }
}

class ProgramCacheItem {
    /**
     * @param {string} uri Document uri string.
     * @param {boolean} isValid Is given Program object valid?
     * @param {Program} program A Program object.
     */
    constructor(uri, isValid, program) {
        /** @type {string} */
        this.uri = uri || "";

        /** @type {boolean} */
        this.isValid = isValid || false;

        /** @type {Program | null} */
        this.program = program || null;
    }
}

/**
 * Normalizes a language setting value.
 *
 * @param {string} language
 * @return {string}
 */
const normalizeLanguage = function(language) {
    language = (language || "").toLowerCase();

    if (language === "fte") {
        return "fteqcc";
    }

    return LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
};

 /** @class SourceDocumentManager */
 module.exports.SourceDocumentManager = class SourceDocumentManager {
    constructor(root, language) {
        /**
         * Path to the workspace root directory.
         * @type {string}
         *  */
        this.workspaceRoot = root;

        /**
         * Document cache.
         *
         * @type Object.<string, DocumentCacheItem>
         */
        this.documents = {};

        /**
         * Program cache.
         *
         * @type {Object.<string, ProgramCacheItem>}
         */
        this.programs = {};

        /**
         * The order to process source documents.
         *
         * @type {string[]}
         */
        this.sourceOrder = [];

        /**
         * Macros defined in progs.src (FTEQCC style).
         *
         * @type {Map<string, Macro>}
         */
        this.projectMacros = new Map();

        /**
         * Documents that #include a given document.
         *
         * @type {Object.<string, Set<string>>}
         */
        this.includedBy = {};

        this.documentsParsed = 0;
        this.language = normalizeLanguage(language);
        this.loadDocuments();
    }

    /**
     * Gets the source document for a given uri
     *
     * @param {string} uri Document uri string.
     * @return {TextDocument} TextDocument object.
     */
    getDocument(uri) {
        const documentCacheItem = this.getDocumentCacheItem(uri);

        if (!documentCacheItem) {
            return null;
        }

        return documentCacheItem.document;
    }

    /**
     * Update document
     *
     * @param {TextDocument} document TextDocument to update.
     */
    updateDocument(document) {
        const uri = this.fromVSCodeUri(document.uri);
        let documentCacheItem = this.getDocumentCacheItem(uri);

        // Update if not currently tracked or newer version
        if (!documentCacheItem || documentCacheItem.version < document.version || documentCacheItem.document.getText() !== document.getText()) {
            documentCacheItem = new DocumentCacheItem(document.version, document, uri);

            this.setDocumentCacheItem(uri, documentCacheItem);

            if (this.isProjectDocument(uri)) {
                this.buildSourceOrder(document, uri);
                this.invalidateProgramCache();
            }
            else if (this.isSourceDocument(uri)) {
                if (!this.getProgramCacheItem(uri)) {
                    this.setProgramCacheItem(uri, new ProgramCacheItem(uri, false, null));
                }
                this.invalidateProgram(uri);
            }

            this.validateProgramCache();
        }
    }

    /**
     * Reloads a document from disk, after it changed outside the editor.
     *
     * @param {string} vscodeUri
     * @param {boolean} deleted
     */
    reloadDocument(vscodeUri, deleted) {
        const uri = this.fromVSCodeUri(vscodeUri);

        if (!this.isSourceDocument(uri) && !this.isProjectDocument(uri)) {
            return;
        }

        if (deleted) {
            this.invalidateProgram(uri);
            delete this.documents[uri.toLowerCase()];
            delete this.programs[uri.toLowerCase()];
            this.validateProgramCache();
            return;
        }

        const document = this.readDocument(uri);

        if (document) {
            const existing = this.getDocument(uri);
            if (!existing || existing.getText() !== document.getText()) {
                this.updateDocument(TextDocument.create(this.toVSCodeUri(uri), document.languageId, (existing ? existing.version : 0) + 1, document.getText()));
            }
        }
    }

    /**
     * Hover request handler.
     *
     * @param {TextDocumentPositionParams} request A Hover request.
     * @return {Hover} A Hover object
     */
    getHover(request) {
        const program = this.getProgram(request.textDocument.uri);

        if (!program) {
            return { contents: "" };
        }

        const type = program.getTypeString(request.position);

        if (!type) {
            return { contents: "" };
        }

        return {
            contents: {
                language: "quakec",
                value: type
            }
        };
    }

    /**
     * Definition request handler.
     *
     * @param {TextDocumentPositionParams} request A definition request.
     * @return {Location} A Location object.
     */
    getDefinition(request) {
        const program = this.getProgram(request.textDocument.uri);

        if (!program) {
            return null;
        }

        const location = program.getDefinition(request.position);

        if (!location || !location.uri) {
            return null;
        }

        return {
            uri: this.toVSCodeUri(location.uri),
            range: location.range
        };
    }

    /**
     * Reference request hander.
     *
     * @param {ReferenceParams} request A reference request.
     * @return {Location[]} Location objects.
     */
    getReferences(request) {
        const program = this.getProgram(request.textDocument.uri);

        if (!program) {
            return [];
        }

        const definition = program.getSymbolDefinition(request.position);

        if (!definition) {
            return [];
        }

        const includeDeclaration = !request.context || request.context.includeDeclaration !== false;
        const target = definition.canonical;
        const locations = [];
        const seen = new Set();

        for (const uri of this.allProgramUris()) {
            const other = this.getProgram(uri);

            if (!other) {
                continue;
            }

            for (const symbol of other.symbols) {
                if (!symbol.definition || symbol.definition.canonical !== target) {
                    continue;
                }

                const isDeclaration = symbol.definition.declarations.some(
                    (d) => d.range === symbol.range
                );

                if (isDeclaration && !includeDeclaration) {
                    continue;
                }

                const key = `${uri}:${symbol.range.start.line}:${symbol.range.start.character}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);

                locations.push({ uri: this.toVSCodeUri(other.uri || uri), range: symbol.range });
            }
        }

        return locations;
    }

    /**
     * Program uris, in source order first.
     *
     * @return {string[]}
     */
    allProgramUris() {
        const ordered = this.sourceOrder.slice();
        const inOrder = new Set(ordered.map((uri) => uri.toLowerCase()));

        for (const key in this.programs) {
            if (!inOrder.has(key)) {
                ordered.push(this.programs[key].uri);
            }
        }

        return ordered;
    }

    /**
     * Get diagnostics for the given document.
     *
     * @param {TextDocument} document TextDocument to get diagnostics for.
     * @return {Diagnostic[]} A Diagnostic object.
     */
    getDiagnostics(document) {
        const program = this.getProgram(document.uri);

        if (!program) {
            return [];
        }

        const diagnostics = [];
        const errors = program.getErrors();

        for (const error of errors) {
            const diagnostic = {
                range: error.range,
                severity: error.severity,
                message: error.message,
                source: "quakec"
            };

            diagnostics.push(diagnostic);
        }

        for (const range of program.inactiveRanges || []) {
            diagnostics.push({
                range: range,
                severity: 4,
                message: "Inactive preprocessor block",
                source: "quakec",
                tags: [1]
            });
        }

        return diagnostics;
    }

    /**
     * Get diagnostics for all documents in the workspace.
     *
     * @return {PublishDiagnosticsParams[]} An array of PublishDiagnosticsParams objects.
     */
    getDiagnosticsAll() {
        /** @type {PublishDiagnosticsParams[]} */
        const publishDiagnosticsParams = [];
        for (const key in this.documents) {
            const item = this.documents[key];

            if (!item || !item.document || !this.isSourceDocument(item.uri)) {
                continue;
            }

            const diagnostics = this.getDiagnostics(item.document);
            publishDiagnosticsParams.push(
                {
                    uri: this.toVSCodeUri(item.uri),
                    diagnostics: diagnostics
                }
            );
        }

        return publishDiagnosticsParams;
    }

    /**
     * Set language.
     *
     * @param {string} language
     */
    setLanguage(language) {
        language = normalizeLanguage(language);

        if (this.language !== language) {
            this.language = language;
            this.invalidateProgramCache();
            this.validateProgramCache();
        }
    }

    /**
     * Get a Program for the given uri.
     *
     * @param {string} uri Document uri string.
     * @return {Program} A Program object.
     */
    getProgram(uri) {
        uri = this.fromVSCodeUri(uri);
        const programCacheItem = this.getProgramCacheItem(uri);

        if (!programCacheItem) {
            return null;
        }

        if (!programCacheItem.isValid) {
            this.validateProgramCache();
        }

        return this.getProgramCacheItem(uri).program;
    }

    /**
     * Load all source documents in workspace.
     */
    loadDocuments() {
        this.documents = {};
        this.programs = {};

        /**
         * Helper function to walk a given directory.
         *
         * @param {string} dir
         * @return {string[]} An array of uri strings.
         */
        const walk = function(dir) {
            let results = [];
            let files;

            try {
                files = fs.readdirSync(dir);
            }
            catch (e) {
                return results;
            }

            for (const file of files) {
                const uri = path.join(dir, file);
                let stat;

                try {
                    stat = fs.statSync(uri);
                }
                catch (e) {
                    continue;
                }

                if (stat.isDirectory()) {
                    if (!SKIPPED_FOLDERS.has(file)) {
                        results = results.concat(walk(uri));
                    }
                }
                else {
                    results.push(uri);
                }
            }

            return results;
        };

        /** @type {string[]} */
        let uris = [];

        if (this.workspaceRoot) {
            uris = walk(this.fromVSCodeUri(this.workspaceRoot));
        }

        for (const uri of uris) {
            if (!this.isSourceDocument(uri) && !this.isProjectDocument(uri)) {
                continue;
            }

            const document = this.loadDocument(uri);

            if (!document) {
                continue;
            }

            if (this.isProjectDocument(uri)) {
                this.buildSourceOrder(document, uri);
            }
        }

        this.validateProgramCache();
    }

    /**
     * Create a TextDocument object from the given uri and update the document
     * cache.
     *
     * @param {string} uri Document uri string.
     * @return {TextDocument} A TextDocument object.
     */
    loadDocument(uri) {
        const document = this.readDocument(uri);

        if (!document) {
            return null;
        }

        const documentCacheItem = new DocumentCacheItem(document.version, document, uri);
        this.setDocumentCacheItem(uri, documentCacheItem);

        if (this.isSourceDocument(uri)) {
            const programCacheItem = new ProgramCacheItem(uri, false, null);
            this.setProgramCacheItem(uri, programCacheItem);
        }

        return document;
    }

    /**
     * Is the given uri is a Quake C source document?
     *
     * @param {string} uri Document uri string.
     * @return {boolean} True if given uri a Quake C source document.
     */
    isSourceDocument(uri) {
        const extension = path.extname(uri).toLowerCase();
        return extension === ".qc" || extension === ".qh";
    }

    /**
     * Is the given uri a Quake C source ordering?
     *
     * @param {string} uri Document uri string.
     * @return {boolean} True if the given uri a Quake C source ordering.
     */
    isProjectDocument(uri) {
        return path.win32.basename(uri).toLowerCase() === "progs.src";
    }

    /**
     * Create a TextDocument object from a given uri.
     *
     * @param {string} uri Document uri string.
     * @return {TextDocument} A TextDocument object.
     */
    readDocument(uri) {
        let content;

        try {
            content = fs.readFileSync(uri, "utf8");
        }
        catch (e) {
            return null;
        }

        let langId = "quakec";
        if (!this.isSourceDocument(uri)) {
            langId = "plaintext";
        }

        return TextDocument.create(uri, langId, 1, content);
    }

    /**
     * Validate all Programs.
     */
    validateProgramCache() {
        const start = new Date().getTime();
        this.documentsParsed = 0;

        // Validate progs.src documents in order, chaining scopes and macros
        // the way the compiler sees them.
        let parentScope = null;
        let macros = this.projectMacros.size > 0 ? this.initialMacros() : null;

        for (const uri of this.sourceOrder) {
            const program = this.validateProgram(uri, parentScope, macros);

            if (program) {
                parentScope = program.scope;
                macros = program.macros;
            }
        }

        // Validate workspace documents.
        const inOrder = new Set(this.sourceOrder.map((uri) => uri.toLowerCase()));
        const remaining = Object.values(this.programs)
            .map(({uri}) => uri)
            .filter((uri) => !inOrder.has(uri.toLowerCase()));

        for (const uri of remaining) {
            this.validateProgram(uri, null, null);
        }

        if (this.documentsParsed > 0) {
            const elapsed = new Date().getTime() - start;
            console.log(`Parsed ${this.documentsParsed} documents in ${elapsed} milliseconds`);
        }
    }

    /**
     * Predefined macros plus the ones defined in progs.src.
     *
     * @return {Map<string, Macro>}
     */
    initialMacros() {
        const { createPredefinedMacros } = require("../../parser/quakec-preprocessor");
        const macros = createPredefinedMacros(this.language);

        for (const [name, macro] of this.projectMacros) {
            macros.set(name, macro);
        }

        return macros;
    }

    /**
     * Validate the given document and return a Program object.
     *
     * @param {string} uri Document uri string.
     * @param {Scope} parentScope Parent Scope object.
     * @param {Map<string, Macro>} macros Macros defined before this document.
     * @return {Program} A Program object.
     */
    validateProgram(uri, parentScope, macros) {
        let programCacheItem = this.getProgramCacheItem(uri);

        if (!programCacheItem) {
            return null;
        }

        // Already valid, or being parsed further up an #include chain.
        if (programCacheItem.isValid || programCacheItem.parsing) {
            return programCacheItem.program;
        }

        const document = this.getDocument(uri);

        if (!document) {
            return null;
        }

        programCacheItem.parsing = true;

        const parseInfo = {
            program: document.getText(),
            uri: programCacheItem.uri,
            parentScope: parentScope,
            macros: macros,
            language: this.language,
            include: (includePath, fromUri) => this.resolveInclude(includePath, fromUri)
        };

        let program;

        try {
            program = parser.parse(parseInfo);
        }
        finally {
            programCacheItem.parsing = false;
        }

        program.uri = programCacheItem.uri;
        programCacheItem = new ProgramCacheItem(programCacheItem.uri, true, program);
        this.setProgramCacheItem(uri, programCacheItem);

        this.documentsParsed += 1;

        return program;
    }

    /**
     * Resolves an #include for the parser.
     *
     * @param {string} includePath The path as written in the source.
     * @param {string} fromUri The including document.
     * @return {{scope: Scope, macros: Map} | null}
     */
    resolveInclude(includePath, fromUri) {
        const candidates = [path.resolve(path.dirname(fromUri), includePath)];

        if (this.workspaceRoot) {
            candidates.push(path.resolve(this.fromVSCodeUri(this.workspaceRoot), includePath));
        }

        for (const candidate of candidates) {
            let item = this.getProgramCacheItem(candidate);

            if (!item) {
                if (!this.loadDocument(candidate) || !this.isSourceDocument(candidate)) {
                    continue;
                }
                item = this.getProgramCacheItem(candidate);
            }

            const key = candidate.toLowerCase();
            this.includedBy[key] = this.includedBy[key] || new Set();
            this.includedBy[key].add(fromUri);

            // Being parsed already: an include cycle.
            if (item.parsing) {
                return { scope: null, macros: new Map() };
            }

            const program = this.validateProgram(candidate, null, null);

            if (!program) {
                return { scope: null, macros: new Map() };
            }

            return { scope: program.scope, macros: program.macros };
        }

        return null;
    }

    /**
     * Invalidate all Program objects.
     */
    invalidateProgramCache() {
        for (const uri in this.programs) {
            this.programs[uri].isValid = false;
        }
    }

    /**
     * Invalidate a given document, and everything that depends on it.
     *
     * @param {string} uri Document uri string.
     * @param {boolean} invalidateDownstream Invalidate all downstream programs?
     */
    invalidateProgram(uri, invalidateDownstream = true, visited = new Set()) {
        const key = uri.toLowerCase();

        if (visited.has(key)) {
            return;
        }
        visited.add(key);

        const programCacheItem = this.getProgramCacheItem(uri);

        if (!programCacheItem) {
            return;
        }

        programCacheItem.isValid = false;

        if (!invalidateDownstream) {
            return;
        }

        const index = this.sourceOrder.findIndex((other) => other.toLowerCase() === key);

        if (index >= 0) {
            for (let i = index + 1; i < this.sourceOrder.length; i++) {
                this.invalidateProgram(this.sourceOrder[i], true, visited);
            }
        }

        for (const includer of this.includedBy[key] || []) {
            this.invalidateProgram(includer, true, visited);
        }
    }

    /**
     * Create a source ordering for the given progs.src document.
     *
     * Supports the classic format (output file, then one source per line)
     * and FTEQCC's #includelist ... #endlist blocks.
     *
     * @param {TextDocument} progsSrcDocument
     * @param {string} uri Normalized path of the progs.src document.
     */
    buildSourceOrder(progsSrcDocument, uri) {
        uri = uri || this.fromVSCodeUri(progsSrcDocument.uri);

        if (!this.isProjectDocument(uri)) {
            return;
        }

        const text = progsSrcDocument.getText().replace(/\/\*[\s\S]*?\*\//g, "");
        const lines = text.split(/\r?\n/).map((line) => line.replace(/\/\/.*/, "").trim());
        const directory = path.dirname(uri);
        const sources = [];
        const macros = new Map();
        let sawOutput = false;
        let inList = false;
        const hasList = lines.some((line) => /^#\s*includelist\b/.test(line));

        for (const line of lines) {
            if (!line) {
                continue;
            }

            if (line.startsWith("#")) {
                const directive = line.match(/^#\s*(\w+)\s*(.*)$/);

                if (!directive) {
                    continue;
                }

                if (directive[1] === "includelist") {
                    inList = true;
                }
                else if (directive[1] === "endlist") {
                    inList = false;
                }
                else if (directive[1] === "define") {
                    const macro = this.parseDefine(directive[2]);
                    if (macro) {
                        macros.set(macro.name, macro);
                    }
                }
                else if (directive[1] === "include" || directive[1] === "includelist") {
                    const file = directive[2].replace(/^["<]|[">]$/g, "");
                    if (file) {
                        sources.push(file);
                    }
                }
                continue;
            }

            if (hasList) {
                if (inList) {
                    sources.push(line.split(/\s+/)[0]);
                }
                continue;
            }

            // Classic format: the first entry is the output file.
            if (!sawOutput) {
                sawOutput = true;
                continue;
            }

            sources.push(line.split(/\s+/)[0]);
        }

        this.projectMacros = macros;
        this.sourceOrder = sources.map((sourceDoc) => path.join(directory, sourceDoc.replace(/\\/g, path.sep)));
    }

    /**
     * Parses the text after `#define` in progs.src.
     *
     * @param {string} text
     * @return {Macro | null}
     */
    parseDefine(text) {
        const lexer = Lexer();
        lexer.setInput(text);
        const tokens = [];
        let token;

        while ((token = lexer.lex())) {
            tokens.push(token);
        }

        if (tokens.length === 0 || (tokens[0].type !== "name" && tokens[0].type !== "type")) {
            return null;
        }

        return new Macro(tokens[0].value, null, false, tokens.slice(1));
    }

    /**
     * Get a ProgramCacheItem for the given document uri.
     *
     * @param {string} uri Document uri string.
     * @return {ProgramCacheItem} A ProgramCacheItem object.
     */
    getProgramCacheItem(uri) {
        return this.programs[uri.toLowerCase()];
    }

    /**
     * Set ProgramCacheItem for given uri string.
     *
     * @param {string} uri Document uri string.
     * @param {ProgramCacheItem} cacheItem ProgramCacheItem to set.
     */
    setProgramCacheItem(uri, cacheItem) {
        this.programs[uri.toLowerCase()] = cacheItem;
    }

    /**
     * Get DocumentCacheItem for given document uri.
     *
     * @param {string} uri Document uri string.
     * @return {DocumentCacheItem} DocumentCacheItem for given uri.
     */
    getDocumentCacheItem(uri) {
        return this.documents[uri.toLowerCase()];
    }

    /**
     * Set the DocumentCacheItem for given document uri.
     *
     * @param {string} uri Document uri string.
     * @param {DocumentCacheItem} cacheItem DocumentCacheItem to set for given uri.
     */
    setDocumentCacheItem(uri, cacheItem) {
        this.documents[uri.toLowerCase()] = cacheItem;
    }

    /**
     * Converts a VS Code uri string to a file system path.
     *
     * @param {string} uri Document uri string, or a path.
     * @return {string} Normalized path.
     */
    fromVSCodeUri(uri) {
        if (/^file:/i.test(uri)) {
            try {
                return path.normalize(url.fileURLToPath(uri));
            }
            catch (e) {
                // Fall through for malformed uris.
            }
        }

        return path.normalize(uri);
    }

    /**
     * Converts a file system path to the uri format VS Code expects.
     *
     * @param {string} uri A path, or an existing uri.
     * @return {string} VS Code specific uri string.
     */
    toVSCodeUri(uri) {
        if (/^file:/i.test(uri)) {
            return uri;
        }

        return url.pathToFileURL(uri).href;
    }
};

module.exports.LANGUAGES = LANGUAGES;
module.exports.DEFAULT_LANGUAGE = DEFAULT_LANGUAGE;
module.exports.normalizeLanguage = normalizeLanguage;
