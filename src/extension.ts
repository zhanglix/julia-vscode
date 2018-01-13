'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'async-file';
import * as path from 'path'
import * as net from 'net';
import * as os from 'os';
import * as telemetry from './telemetry';
import { spawn, ChildProcess } from 'child_process';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, StreamInfo } from 'vscode-languageclient';
import * as vslc from 'vscode-languageclient';
import * as rpc from 'vscode-jsonrpc';
import * as repl from './repl';
import * as weave from './weave';
import * as tasks from './tasks';
import * as settings from './settings';
import * as smallcommands from './smallcommands';
import * as packagepath from './packagepath';
import * as openpackagedirectory from './openpackagedirectory';
import * as juliaexepath from './juliaexepath';

let g_settings: settings.ISettings = null;
let g_languageClient: LanguageClient = null;
let g_context: vscode.ExtensionContext = null;

let g_serverstatus: vscode.StatusBarItem = null;
let g_serverBusyNotification = new rpc.NotificationType<string, void>('window/setStatusBusy');
let g_serverReadyNotification = new rpc.NotificationType<string, void>('window/setStatusReady');

export async function activate(context: vscode.ExtensionContext) {  
    telemetry.init();

    telemetry.traceEvent('activate');

    telemetry.startLsCrashServer();

    g_context = context;

    console.log('Activating extension language-julia');

    g_settings = settings.loadSettings();

    // Status bar
    g_serverstatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    g_serverstatus.show()
    g_serverstatus.text = 'Julia Language Server is busy';
    context.subscriptions.push(g_serverstatus);

    // Config change
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(configChanged));

    // Language settings
    vscode.languages.setLanguageConfiguration('julia', {
        indentationRules: {
            increaseIndentPattern: /^(\s*|.*=\s*|.*@\w*\s*)[\w\s]*\b(if|while|for|function|macro|immutable|struct|type|let|quote|try|begin|.*\)\s*do|else|elseif|catch|finally)\b(?!.*\bend\b[^\]]*$).*$/,
            decreaseIndentPattern: /^\s*(end|else|elseif|catch|finally)\b.*$/
        }
    });

    // Active features from other files
    juliaexepath.activate(context, g_settings);
    repl.activate(context, g_settings);
    weave.activate(context, g_settings);
    tasks.activate(context, g_settings);
    smallcommands.activate(context, g_settings);
    packagepath.activate(context, g_settings);
    openpackagedirectory.activate(context, g_settings);

    // Start language server
    startLanguageServer();

    if (vscode.workspace.getConfiguration('julia').get<boolean>('enableTelemetry')===null) {
        vscode.window.showInformationMessage("To help improve the julia extension, you can anonymously send usage statistics to the team.", 'Yes, I want to help improve the julia extension')
            .then(telemetry_choice => {
                if (telemetry_choice == "Yes, I want to help improve the julia extension") {
                    vscode.workspace.getConfiguration('julia').update('enableTelemetry', true, true);
                }
            });
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
}

function setLanguageClient(languageClient: vslc.LanguageClient) {
    g_languageClient = languageClient;

    juliaexepath.onNewLanguageClient(g_languageClient);
    repl.onNewLanguageClient(g_languageClient);
    weave.onNewLanguageClient(g_languageClient);
    tasks.onNewLanguageClient(g_languageClient);
    smallcommands.onNewLanguageClient(g_languageClient);
    packagepath.onNewLanguageClient(g_languageClient);
    openpackagedirectory.onNewLanguageClient(g_languageClient);
}

function configChanged(params) {
    let newSettings = settings.loadSettings();

    telemetry.onDidChangeConfiguration(newSettings);
    juliaexepath.onDidChangeConfiguration(newSettings);    
    repl.onDidChangeConfiguration(newSettings);
    weave.onDidChangeConfiguration(newSettings);
    tasks.onDidChangeConfiguration(newSettings);
    smallcommands.onDidChangeConfiguration(newSettings);
    packagepath.onDidChangeConfiguration(newSettings);
    openpackagedirectory.onDidChangeConfiguration(newSettings);

    let need_to_restart_server = false;

    if (g_settings.juliaExePath != newSettings.juliaExePath) {
        need_to_restart_server = true;
    }

    if (need_to_restart_server) {
        if (g_languageClient != null) {
            g_languageClient.stop();
            setLanguageClient(null);
        }

        startLanguageServer();
    }
}

async function startLanguageServer() {
    // let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };

    try {
        var originalJuliaPkgDir = await packagepath.getPkgPath();
    }
    catch (e) {
        vscode.window.showErrorMessage('Could not start the julia language server. Make sure the configuration setting julia.executablePath points to the julia binary.');
        return;
    }
    let serverArgsRun = ['--startup-file=no', '--history-file=no', 'main.jl', originalJuliaPkgDir, '--debug=no', process.pid.toString()];
    let serverArgsDebug = ['--startup-file=no', '--history-file=no', 'main.jl', originalJuliaPkgDir, '--debug=yes', process.pid.toString()];
    let spawnOptions = {
        cwd: path.join(g_context.extensionPath, 'scripts', 'languageserver'),
        env: {
            JULIA_PKGDIR: path.join(g_context.extensionPath, 'scripts', 'languageserver', 'julia_pkgdir'),
            HOME: process.env.HOME ? process.env.HOME : os.homedir()
        }
    };

    let jlexepath = await juliaexepath.getJuliaExePath();

    let serverOptions = {
        run: { command: jlexepath, args: serverArgsRun, options: spawnOptions },
        debug: { command: jlexepath, args: serverArgsDebug, options: spawnOptions }
    };

    let clientOptions: LanguageClientOptions = {
        documentSelector: ['julia', 'juliamarkdown'],
        synchronize: {
            configurationSection: ['julia.runlinter', 'julia.lintIgnoreList'],
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.jl')
        },
        revealOutputChannelOn: RevealOutputChannelOn.never
    }

        // Create the language client and start the client.
    g_languageClient = new LanguageClient('julia Language Server', serverOptions, clientOptions);
    g_languageClient.registerProposedFeatures()

    // Push the disposable to the context's subscriptions so that the
    // client can be deactivated on extension deactivation
    try {
        g_context.subscriptions.push(g_languageClient.start());
        setLanguageClient(g_languageClient);
    }
    catch (e) {
        vscode.window.showErrorMessage('Could not start the julia language server. Make sure the configuration setting julia.executablePath points to the julia binary.');
        g_languageClient = null;
    }

    g_languageClient.onReady().then(() => {
        g_languageClient.onNotification(g_serverBusyNotification, () => {
            g_serverstatus.show();
        })

        g_languageClient.onNotification(g_serverReadyNotification, () => {
            g_serverstatus.hide();
        })
    })
}
