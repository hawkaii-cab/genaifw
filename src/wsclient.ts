/**
 * Interactive CLI client for testing the WebSocket server.
 * Supports audio playback of streamed WAV buffers.
 *
 * Usage:
 *   bun run src/wsclient.ts
 *
 * Environment variables:
 *   WS_URL       WebSocket server URL  (default: ws://localhost:3001)
 *   SESSION_ID   Session ID to use     (default: cli-test-<timestamp>)
 *   AUDIO_PLAYER Audio player command  (default: auto-detect)
 *
 * Commands (at the prompt):
 *   <text>                    Send a "message" event
 *   /init [json]              Send an "init" event with optional context JSON
 *   /screen <name>            Send a "screenChange" event
 *   /submit <name> [json]     Send a "submit" event with optional data JSON
 *   /session                  Show current session ID
 *   /newsession               Generate a new session ID
 *   /raw <json>               Send a raw JSON payload
 *   /help                     Show this help
 *   /exit                     Disconnect and exit
 */

import WebSocket from "ws";
import * as readline from "readline";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";
import type { ClientEvent, WSServerMessage, ServerAction } from "./types";

// ─── Config ──────────────────────────────────────────────────────────────────

// const WS_URL = process.env.WS_URL ?? "ws://34.124.247.222:3001";
const WS_URL = process.env.WS_URL ?? "ws://localhost:3001";
let sessionId = process.env.SESSION_ID ?? `cli-test-${Date.now()}`;

// ─── ANSI colours ────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

const c = (col: string, t: string) => `${col}${t}${R}`;

// ─── Audio playback ──────────────────────────────────────────────────────────

// Detect available audio player once at startup.
function detectPlayer(): string | null {
    // Explicit override via env
    if (process.env.AUDIO_PLAYER) return process.env.AUDIO_PLAYER;

    const { execSync } = require("child_process") as typeof import("child_process");
    const candidates =
        process.platform === "darwin"
            ? ["afplay", "ffplay", "mpv"]
            : ["aplay", "ffplay", "mpv", "sox"];

    for (const p of candidates) {
        try {
            execSync(`which ${p}`, { stdio: "ignore" });
            return p;
        } catch {
            // not found
        }
    }
    return null;
}

const PLAYER = detectPlayer();

function playWavBuffer(buf: Buffer): void {
    if (!PLAYER) {
        console.log(c(YELLOW, "[audio] No player found. Install aplay/ffplay/mpv to hear audio."));
        return;
    }

    // Build player args – write to a tmp file so any player can handle it.
    const tmpFile = join(tmpdir(), `genaifw-audio-${Date.now()}.wav`);
    try {
        writeFileSync(tmpFile, buf);

        let args: string[];
        switch (PLAYER) {
            case "afplay":
                args = [tmpFile];
                break;
            case "aplay":
                args = ["-q", tmpFile];
                break;
            case "ffplay":
                args = ["-nodisp", "-autoexit", "-loglevel", "quiet", tmpFile];
                break;
            case "mpv":
                args = ["--no-video", "--really-quiet", tmpFile];
                break;
            case "sox":
            case "play":
                args = [tmpFile];
                break;
            default:
                args = [tmpFile];
        }

        const child = spawn(PLAYER, args, { stdio: "ignore", detached: true });
        child.on("error", (e) =>
            console.log(c(YELLOW, `[audio] Player error: ${e.message}`)),
        );
        child.on("exit", () => {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
        });
        child.unref();
    } catch (e: unknown) {
        console.log(c(YELLOW, `[audio] Playback failed: ${(e as Error).message}`));
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

// ─── Message rendering ───────────────────────────────────────────────────────

function formatAction(action: ServerAction): string {
    switch (action.type) {
        case "speak":
            return `${c(GREEN, "speak")}    ${c(BOLD, action.text)}`;
        case "playAudio":
            return `${c(YELLOW, "audio")}    key=${action.key}${action.value ? `  url=${action.value}` : ""}`;
        case "navigate":
            return `${c(CYAN, "navigate")} screen=${c(BOLD, action.screen)}${
                action.data ? `  data=${JSON.stringify(action.data)}` : ""
            }`;
        case "uiAction":
            return `${c(MAGENTA, "uiAction")} action=${action.action}${
                action.data ? `  data=${JSON.stringify(action.data)}` : ""
            }`;
        case "endConversation":
            return c(RED, "endConversation");
        default:
            return JSON.stringify(action);
    }
}

function printActions(msg: WSServerMessage & { type: "actions" }): void {
    const { message } = msg;
    console.log(`\n${c(BLUE, "─".repeat(52))}`);
    if (message.metadata?.intent || message.metadata?.feature) {
        const parts: string[] = [];
        if (message.metadata.intent) parts.push(`intent=${message.metadata.intent}`);
        if (message.metadata.feature) parts.push(`feature=${message.metadata.feature}`);
        console.log(c(DIM, `  ${parts.join("  ")}`));
    }
    for (const action of message.actions) {
        console.log(`  ${formatAction(action)}`);
    }
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

function send(ws: WebSocket, event: ClientEvent): void {
    if (ws.readyState !== WebSocket.OPEN) {
        console.log(c(RED, "Not connected."));
        return;
    }
    ws.send(JSON.stringify(event));
    console.log(c(DIM, `→ sent ${event.type}`));
}

function parseOptionalJson(raw: string): Record<string, unknown> | undefined {
    const s = raw.trim();
    if (!s) return undefined;
    try {
        return JSON.parse(s) as Record<string, unknown>;
    } catch {
        console.log(c(RED, `Invalid JSON: ${s}`));
        return undefined;
    }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
    console.log(`
${c(BOLD, "Commands:")}
  ${c(CYAN, "<text>")}                   Send a "message" event
  ${c(CYAN, "/init [json]")}             Send an "init" event with optional context JSON
  ${c(CYAN, "/screen <name>")}           Send a "screenChange" event
  ${c(CYAN, "/submit <name> [json]")}    Send a "submit" event with optional data JSON
  ${c(CYAN, "/session")}                 Show current session ID
  ${c(CYAN, "/newsession")}              Generate a new session ID
  ${c(CYAN, "/raw <json>")}              Send a raw JSON payload
  ${c(CYAN, "/help")}                    Show this help
  ${c(CYAN, "/exit")}                    Disconnect and exit
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(c(BOLD, "\nWS Test Client"));
    console.log(`Connecting to ${c(CYAN, WS_URL)} ...`);

    const ws = new WebSocket(WS_URL);

    await Promise.race([
        new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        }),
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Connection timed out after 5s")), 5000),
        ),
    ]);

    console.log(c(GREEN, "Connected!"));
    console.log(`Session : ${c(CYAN, sessionId)}`);
    console.log(`Audio   : ${PLAYER ? c(GREEN, PLAYER) : c(YELLOW, "no player detected")}`);
    printHelp();

    // ── Audio state ──────────────────────────────────────────────────────────
    let inAudio = false;
    let audioChunks: Buffer[] = [];

    // ── Incoming messages ────────────────────────────────────────────────────
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
            // Binary chunk = raw audio PCM/WAV data
            if (inAudio) {
                audioChunks.push(Buffer.from(data as Buffer));
            }
            return;
        }

        let msg: WSServerMessage;
        try {
            msg = JSON.parse((data as Buffer).toString()) as WSServerMessage;
        } catch {
            console.log(c(RED, `Non-JSON text: ${data}`));
            rl.prompt(true);
            return;
        }

        switch (msg.type) {
            case "actions":
                printActions(msg);
                // Play pre-recorded audio via URL (no binary stream needed)
                for (const action of msg.message.actions) {
                    if (action.type === "playAudio" && action.value) {
                        console.log(c(DIM, `[audio] fetching ${action.key}…`));
                        fetch(action.value)
                            .then((r) => r.arrayBuffer())
                            .then((buf) => {
                                console.log(c(DIM, `[audio] playing ${action.key} (${buf.byteLength} B)`));
                                playWavBuffer(Buffer.from(buf));
                            })
                            .catch((e: unknown) =>
                                console.log(c(YELLOW, `[audio] fetch failed: ${(e as Error).message}`)),
                            );
                        break; // only play first audio action
                    }
                }
                break;

            case "audio_start":
                inAudio = true;
                audioChunks = [];
                console.log(c(DIM, `\n[audio stream starting – ${msg.contentType} ${msg.size} B]`));
                break;

            case "audio_end": {
                inAudio = false;
                const combined = Buffer.concat(audioChunks);
                audioChunks = [];
                console.log(c(DIM, `[audio stream complete – ${combined.length} B received – playing…]`));
                playWavBuffer(combined);
                break;
            }

            case "error":
                console.log(`\n${c(RED, "SERVER ERROR")} ${msg.error}`);
                break;

            default:
                console.log("\n[unknown message]", JSON.stringify(msg));
        }

        rl.prompt(true);
    });

    ws.on("close", () => {
        console.log(c(YELLOW, "\nServer disconnected."));
        process.exit(0);
    });

    ws.on("error", (e) => {
        console.log(c(RED, `\nSocket error: ${e.message}`));
    });

    // ── Readline ─────────────────────────────────────────────────────────────
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `\n${c(BOLD, "You")}> `,
    });

    rl.prompt();

    rl.on("line", (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        if (input === "/exit" || input === "/quit") {
            console.log("Goodbye!");
            ws.close();
            rl.close();
            return;
        }

        if (input === "/help") { printHelp(); rl.prompt(); return; }

        if (input === "/session") {
            console.log(`Session: ${c(CYAN, sessionId)}`);
            rl.prompt(); return;
        }

        if (input === "/newsession") {
            sessionId = `cli-test-${Date.now()}`;
            console.log(`New session: ${c(CYAN, sessionId)}`);
            rl.prompt(); return;
        }

        if (input.startsWith("/init")) {
            const rest = input.slice("/init".length).trim();
            const ctx = parseOptionalJson(rest);
            send(ws, { sessionId, type: "init", context: ctx as ClientEvent["context"] });
            rl.prompt(); return;
        }

        if (input.startsWith("/screen ")) {
            const screen = input.slice("/screen ".length).trim();
            if (!screen) { console.log(c(RED, "Usage: /screen <name>")); }
            else { send(ws, { sessionId, type: "screenChange", screen }); }
            rl.prompt(); return;
        }

        if (input.startsWith("/submit")) {
            const rest = input.slice("/submit".length).trim();
            const spaceIdx = rest.indexOf(" ");
            const screen = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
            const jsonPart = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
            if (!screen) { console.log(c(RED, "Usage: /submit <name> [json]")); rl.prompt(); return; }
            const data = parseOptionalJson(jsonPart);
            send(ws, { sessionId, type: "submit", screen, ...(data ? { data } : {}) });
            rl.prompt(); return;
        }

        if (input.startsWith("/raw ")) {
            const jsonStr = input.slice("/raw ".length).trim();
            try {
                const payload = JSON.parse(jsonStr);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(payload));
                    console.log(c(DIM, `→ raw sent`));
                } else { console.log(c(RED, "Not connected.")); }
            } catch { console.log(c(RED, "Invalid JSON for /raw")); }
            rl.prompt(); return;
        }

        if (input.startsWith("/")) {
            console.log(c(RED, `Unknown command: ${input}`));
            console.log(c(DIM, "Type /help for available commands."));
            rl.prompt(); return;
        }

        // Plain text → message event
        send(ws, { sessionId, type: "message", text: input });
    });

    rl.on("close", () => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
        process.exit(0);
    });
}

main().catch((e: unknown) => {
    console.error(c(RED, `Fatal: ${(e as Error).message}`));
    process.exit(1);
});
