'use strict';

const {
	IPCMessageReader,
	IPCMessageWriter,
	createConnection,
	TextDocuments,
	TextDocumentSyncKind,
	FileChangeType
} = require('vscode-languageserver');

const { TextDocument } = require('vscode-languageserver-textdocument');
const { SourceDocumentManager, DEFAULT_LANGUAGE } = require('./language');

const connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

/** @type {SourceDocumentManager} */
let documentManager;

let workspaceRoot;
connection.onInitialize((params) => {
	// Use this to build a listing of project directory.
	workspaceRoot = params.rootUri;
	documentManager = new SourceDocumentManager(workspaceRoot);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			definitionProvider: true,
			hoverProvider: true,
			referencesProvider: true
		}
	};
});

documents.onDidChangeContent((change) => {
	documentManager.updateDocument(change.document);
	sendDiagnostics();
});

/** @type {string} */
let language;

const sendDiagnostics = function() {
	const diagnostics = documentManager.getDiagnosticsAll();

	for (const d of diagnostics) {
		connection.sendDiagnostics(d);
	}
};

connection.onDidChangeConfiguration((change) => {
	const settings = change.settings;
	language = (settings && settings.quakec && settings.quakec.language) || DEFAULT_LANGUAGE;
	documentManager.setLanguage(language);
	sendDiagnostics();
});

// Pick up changes made outside the editor, such as a git checkout.
connection.onDidChangeWatchedFiles((params) => {
	for (const change of params.changes) {
		// Open documents are kept up to date by the editor.
		if (documents.get(change.uri)) {
			continue;
		}

		documentManager.reloadDocument(change.uri, change.type === FileChangeType.Deleted);
	}

	sendDiagnostics();
});

connection.onDefinition((request) => {
	return documentManager.getDefinition(request);
});

connection.onHover((request) => {
	return documentManager.getHover(request);
});

connection.onReferences((request) => {
	return documentManager.getReferences(request);
});

connection.listen();
