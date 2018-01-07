'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
    commands,
    Disposable,
    ExtensionContext,
    TextDocument,
    Uri,
    ViewColumn,
    window,
    workspace,
    WorkspaceEdit,
    TextEditor,
    Position, 
    Range
} from 'vscode';

import { EventEmitter } from 'events';
import * as nodeRepl from 'repl';
import { Writable, Readable } from 'stream';

let parser: ReplExtension;
let outputWindow = window.createOutputChannel("NodeJs REPL");

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    let disposable = commands.registerCommand('extension.nodejsRepl', () => {
        parser = new ReplExtension();
    });

    context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
}

class ReplExtension {
    private changeEventDisposable: Disposable;
    private repl: NodeRepl;

    private inputEditor: TextEditor;
    private outputEditor: TextEditor;

    private interpretTimer: NodeJS.Timer = null;

    constructor() {
        this.repl = new NodeRepl();

        this.init();
    }

    public async init() {
        await this.showTextDocuments();

        this.changeEventDisposable = workspace.onDidChangeTextDocument(async (event) => {
            try 
            {
                if (event.document !== this.inputEditor.document) {
                    return;
                }
                
                let text = event.contentChanges[0].text;

                outputWindow.show();

                if(text.indexOf(';') >= 0 || text.indexOf('\n') >= 0) {
                    await this.interpret(this.inputEditor.document.getText());
                } 
                else {
                    if(this.interpretTimer)
                        clearTimeout(this.interpretTimer);
                    
                    this.interpretTimer = setTimeout(async () => {
                        await this.interpret(this.inputEditor.document.getText());
                    }, 2000);
                }
            }
            catch(err) {
                outputWindow.appendLine(err);
            }
        });
    }

    public async interpret(code: string) {
        try {
            if(this.outputEditor.document.isClosed == true)
                await this.showOutputEditor();

            let output = await this.repl.interpret(code),
                result = output
                    .filter(r => r.type != 'output')
                    .map(r => `${r.type == 'result' ? '// ' : ''}${r.text}`)
                    .join('\n'),
                console = output
                    .filter(r => r.type == 'output')
                    .map(r => `${r.text}`)
                    .join('\n');

            await this.outputEditor.edit(async (edit) => {
                edit.replace(new Range(new Position(0,0), new Position(this.outputEditor.document.lineCount, 35768)), '');
                edit.insert(new Position(0, 0), `${result}\n\n/*\n${console}\n*/`);
            });
        } 
        catch(ex) {
            outputWindow.appendLine(ex);

            return false;
        }

        return true;
    }

    public async showTextDocuments(): Promise<void> {
        await Promise.all([this.showInputEditor(), this.showOutputEditor()]);
    }

    private async showOutputEditor() {
        if(this.outputEditor && this.outputEditor.document.isClosed == false)
            return;

        this.outputEditor = await window.showTextDocument(await workspace.openTextDocument({ content: '', language: 'javascript' }), ViewColumn.Two, true);
    }

    private async showInputEditor() {
        if(this.inputEditor && this.inputEditor.document.isClosed == false)
            return;
            
        this.inputEditor = await window.showTextDocument(await workspace.openTextDocument({ content: '', language: 'javascript' }), ViewColumn.One);
    }
}

class NodeRepl {
    private replEval: (cmd: string, context: any, filename: string, cb: (err?: Error, result?: string) => void) => void;

    constructor() {
        
    }

    public async interpret(code: string): Promise<Array<{type: string, text: string}>> {
        return new Promise<Array<{type: string, text: string}>>((resolve, reject) => {
            try {
                outputWindow.appendLine(`[${new Date().toLocaleTimeString()}] starting to interpret ${code.length} bytes of code`);

                let output: Array<{type: string, text: string}> = [],
                    outputConsole = [],
                    lineCount = 0,
                    resultCount = 0;

                let inputStream = new Readable({
                        read: () => {

                        }
                    }),
                    outputStream = new Writable({
                        write: (chunk, enc, cb) => {
                            let out = chunk.toString().trim();
                            switch(out) {
                                case 'undefined':
                                case '...':
                                case '':
                                    break;

                                default:
                                    outputConsole.push(out); 
                                    outputWindow.appendLine(`  ${out}`);
                                    break;
                            }
                            cb();
                        }
                    });

                inputStream.push("");

                let repl = nodeRepl.start({
                    prompt: '',
                    input: inputStream,
                    output: outputStream,
                    writer: (out) => {
                        // if not implmented, the result will be outputted to stdout/output stream
                    }
                })

                if(this.replEval == null)
                    this.replEval = (<any>repl).eval; // keep a backup of original eval

                // nice place to read the result in sequence and inject it in the code
                (<any>repl).eval = (cmd: string, context: any, filename: string, cb: (err?: Error, result?: any) => void) => {
                    
                    this.replEval(cmd, context, filename, (err, result) => {
                        lineCount++;

                        if(result != null) {
                            output.splice((lineCount - 1) + ++resultCount, 0, { type: 'result', text: result});
                        }

                        cb(err, result);
                    })
                }

                code = this.rewriteImport(code);

                for(let line of code.split(/\r\n|\n/))
                {
                    inputStream.push(`${line}\n`); // tell the REPL about the line of code to see if there is any result coming out of it
                    output.push({ type: 'code', text: `${line}`});
                }

                inputStream.on('end', () => {
                    // finally, done for now.
                    resolve(output.concat( outputConsole.map(r => <any>{ type: 'output', text: r }) )); 
                })

                inputStream.push(null);
            }
            catch(ex)
            {
                reject(ex);
            }
        })
    }

    private rewriteImport(code: string): string {
        let regex = /import\s*(?:(\*\s+as\s)?([\w-_]+),?)?\s*(?:\{([^\}]+)\})?\s+from\s+(["'][^"']+["'])/gi,
            match;

        return code.replace(regex, (str: string, wildcard: string, module: string, modules: string, from) => {
            let rewrite = '';

            if(module)
                rewrite += `${rewrite == '' ? '' : ', '}${module}: _default`;
        
            if(modules) 
                rewrite += `${rewrite == '' ? '' : ', '}${modules
                    .split(',')
                    .map(r => r.replace(/\s*([\w-_]+)(?:\s+as\s+([\w-_]))?\s*/gi, (str, moduleName: string, moduleNewName: string) => {
                        return `${moduleNewName ? `${moduleNewName.trim()}: ` : ``}${moduleName.trim()}`;
                    }))
                    .join(', ')}`;

            return `const ${wildcard ? module : `{ ${rewrite} }`} = require(${from})`;
        });
    }
}