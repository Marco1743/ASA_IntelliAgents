export function calculate(expression) {
    try {
        return String(eval(String(expression)));
    } catch (err) {
        return `Error: ${err.message}`;
    }
}

export function getMyPosition(state) {
    if (state.me.x === undefined) return null;
    return { x: Math.round(state.me.x), y: Math.round(state.me.y), score: state.me.score };
}

export function getParcels(state) {
    return state.freeParcels.map(p => ({ id: p.id, x: p.x, y: p.y, reward: p.reward }));
}

export function walkableTiles(state) {
    const out = [];
    for (const [key, type] of state.map.entries()) {
        if (String(type) === '0') continue;
        const [x, y] = key.split(',').map(Number);
        out.push({ x, y });
    }
    return out;
}

// where: "leftmost" | "rightmost" | "topmost" | "bottommost" — returns the middle
// tile of the extreme row/column (pass deliveryZones for "leftmost delivery tile").
export function resolveRelative(tiles, where) {
    if (!tiles || tiles.length === 0) return null;
    const mid = arr => arr[Math.floor(arr.length / 2)];
    if (where === 'leftmost')   { const m = Math.min(...tiles.map(t => t.x)); return mid(tiles.filter(t => t.x === m)); }
    if (where === 'rightmost')  { const m = Math.max(...tiles.map(t => t.x)); return mid(tiles.filter(t => t.x === m)); }
    if (where === 'bottommost') { const m = Math.min(...tiles.map(t => t.y)); return mid(tiles.filter(t => t.y === m)); }
    if (where === 'topmost')    { const m = Math.max(...tiles.map(t => t.y)); return mid(tiles.filter(t => t.y === m)); }
    return null;
}

export function getMapInfo(state) {
    const walkable = walkableTiles(state);
    if (walkable.length === 0) return null;
    return {
        width: state.mapWidth,
        height: state.mapHeight,
        deliveryZones: state.deliveryZones,
        leftmost:   resolveRelative(walkable, 'leftmost'),
        rightmost:  resolveRelative(walkable, 'rightmost'),
        bottommost: resolveRelative(walkable, 'bottommost'),
        topmost:    resolveRelative(walkable, 'topmost')
    };
}

// read-only tools the LLM planner may call while reasoning (catalog text shown to
// the model; execTool runs one by name). They never move the agent.
export const TOOL_CATALOG = [
    'calculate(expression): evaluate arithmetic, e.g. "4*2" or "(1+3)*3"',
    'get_my_position(): the agent\'s current {x, y, score}',
    'get_parcels(): visible free parcels as [{id, x, y, reward}]',
    'get_map_info(): {width, height, deliveryZones, leftmost, rightmost, topmost, bottommost}'
];

export function execTool(name, input, state) {
    switch (String(name).trim()) {
        case 'calculate':        return calculate(input);
        case 'get_my_position':  return JSON.stringify(getMyPosition(state));
        case 'get_parcels':      return JSON.stringify(getParcels(state));
        case 'get_map_info':     return JSON.stringify(getMapInfo(state));
        default:                 return `Error: unknown tool '${name}'`;
    }
}
