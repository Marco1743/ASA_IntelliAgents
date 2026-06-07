
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

async function probe(host) {
    try {
        const r = await fetch(`${host}/api/version`);
        return r.ok ? await r.json() : null;
    } catch (_) { return null; }
}

async function detectCLI() {
    return new Promise(resolve => {
        const p = spawn('ollama', ['--version'], { shell: false, windowsHide: true });
        let out = '';
        p.stdout.on('data', d => out += d.toString());
        p.on('error', () => resolve(null));
        p.on('close', code => resolve(code === 0 ? out.trim() : null));
    });
}

async function listInstalled(host) {
    try {
        const r = await fetch(`${host}/api/tags`);
        if (!r.ok) return [];
        const data = await r.json();
        return (data.models || []).map(m => m.name);
    } catch (_) { return []; }
}

function isInstalled(name, installed) {
    const needle = name.includes(':') ? name : `${name}:latest`;
    return installed.includes(name) || installed.includes(needle);
}

async function pullModel(host, model) {
    console.log(`[ollama] pulling model '${model}' — this can take a few minutes on first run...`);
    const resp = await fetch(`${host}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true })
    });
    if (!resp.ok || !resp.body) throw new Error(`pull failed: HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', lastStatus = '', streamError = null, sawSuccess = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); } catch (_) { continue; }

            if (obj.error) { streamError = obj.error; continue; }
            const status = obj.status || '';
            if (status === 'success') sawSuccess = true;
            if (status && status !== lastStatus) {
                lastStatus = status;
                if (obj.total && obj.completed) {
                    const pct = Math.floor((obj.completed / obj.total) * 100);
                    process.stdout.write(`\r[ollama] ${status} ${pct}%                `);
                } else {
                    process.stdout.write(`\r[ollama] ${status}                          `);
                }
            } else if (obj.total && obj.completed) {
                const pct = Math.floor((obj.completed / obj.total) * 100);
                process.stdout.write(`\r[ollama] ${status} ${pct}%                `);
            }
        }
    }
    process.stdout.write('\n');
    if (streamError) throw new Error(`pull failed: ${streamError}`);
    if (!sawSuccess) throw new Error(`pull ended without success — model '${model}' may not exist on Ollama Registry`);

    const installed = await listInstalled(host);
    if (!isInstalled(model, installed)) {
        throw new Error(`pull reported success but '${model}' is not in /api/tags`);
    }
    console.log(`[ollama] model '${model}' ready`);
}

let _daemon = null;

function spawnDaemon() {
    console.log('[ollama] starting daemon (ollama serve)...');
    const child = spawn('ollama', ['serve'], {
        shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => process.stderr.write(`[ollama] ${d.toString().trimEnd()}\n`));
    child.stderr.on('data', d => process.stderr.write(`[ollama] ${d.toString().trimEnd()}\n`));
    child.on('exit', code => {
        if (_daemon === child) _daemon = null;
        if (code !== 0 && code !== null) console.error(`[ollama] daemon exited (code ${code})`);
    });
    _daemon = child;
    installCleanup();
    return child;
}

function installCleanup() {
    const kill = () => { if (_daemon && !_daemon.killed) try { _daemon.kill(); } catch (_) {} };
    process.on('exit',    kill);
    process.on('SIGINT',  () => { kill(); process.exit(0); });
    process.on('SIGTERM', () => { kill(); process.exit(0); });
}

export async function ensureOllama({ host = DEFAULT_HOST, model } = {}) {
    if (!model) throw new Error('ensureOllama: model is required');

    let alive = await probe(host);
    if (!alive) {
        const cli = await detectCLI();
        if (!cli) {
            console.error('[ollama] command not found in PATH.');
            console.error('[ollama] To install on Windows:  winget install --id Ollama.Ollama');
            console.error('[ollama] Or download:            https://ollama.com/download');
            console.error('[ollama] After installing, CLOSE AND REOPEN this terminal.');
            throw new Error('ollama not installed');
        }
        console.log(`[ollama] CLI detected: ${cli}`);
        spawnDaemon();

        const start = Date.now();
        while (Date.now() - start < READY_TIMEOUT_MS) {
            alive = await probe(host);
            if (alive) break;
            await wait(POLL_INTERVAL_MS);
        }
        if (!alive) throw new Error(`daemon did not become ready within ${READY_TIMEOUT_MS}ms`);
        console.log(`[ollama] daemon ready (v${alive.version || '?'})`);
    } else {
        console.log(`[ollama] daemon already running (v${alive.version || '?'})`);
    }

    const installed = await listInstalled(host);
    if (!isInstalled(model, installed)) {
        console.log(`[ollama] model '${model}' not installed (have: ${installed.join(', ') || 'none'})`);
        await pullModel(host, model);
    } else {
        console.log(`[ollama] model '${model}' already installed`);
    }

    return { host, model, openaiBaseURL: `${host}/v1` };
}
