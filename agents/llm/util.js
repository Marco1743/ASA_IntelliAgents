// Split a message into separate missions on newlines, semicolons or list markers
// (not on '.', so multi-sentence missions stay whole). Always returns >= 1 entry.
export function splitMissions(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return [];
    const parts = raw
        .split(/\r?\n+|\s*;\s*/)
        .map(s => s.replace(/^\s*(?:\d+[.)]|[-•*])\s+/, '').trim())
        .filter(s => s.length >= 3);
    return parts.length ? parts : [raw];
}

// Parse a JSON object from an LLM reply (strips ``` fences); null on failure.
export function safeJsonParse(text) {
    if (typeof text !== 'string') return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
        return null;
    }
}

// Parse a JSON array from an LLM reply; null on failure.
export function parseJsonArray(text) {
    if (typeof text !== 'string') return null;
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const tryParse = s => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; } };
    return tryParse(cleaned) || tryParse((cleaned.match(/\[[\s\S]*\]/) || [])[0] || '');
}
