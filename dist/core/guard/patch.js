const HEADER = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/;
const MOVE = /^\*\*\* Move to: (.+?)\s*$/;
export function parsePatch(text) {
    const files = [];
    let current = null;
    const flush = () => {
        if (current)
            files.push({ path: current.path, op: current.op, ...(current.moveTo ? { moveTo: current.moveTo } : {}), added: current.lines.join("\n") });
    };
    for (const line of text.split(/\r?\n/)) {
        const header = HEADER.exec(line);
        if (header) {
            flush();
            current = { path: header[2], op: header[1].toLowerCase(), added: "", lines: [] };
            continue;
        }
        if (!current)
            continue;
        const move = MOVE.exec(line);
        if (move)
            current.moveTo = move[1];
        else if (line.startsWith("+"))
            current.lines.push(line.slice(1));
    }
    flush();
    return files;
}
/** The patch text from an apply_patch tool input (Codex sends it as `command`; other shapes for safety). */
export function patchText(input) {
    for (const key of ["command", "patch", "input"]) {
        const v = input[key];
        if (typeof v === "string" && v.includes("*** "))
            return v;
        if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
            const joined = v.join("\n");
            if (joined.includes("*** "))
                return joined;
        }
    }
    return null;
}
