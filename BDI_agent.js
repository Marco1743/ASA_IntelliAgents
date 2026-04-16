/**
 * BDI_Agent.js
 * Sviluppato per il progetto Deliveroo.js - Università di Trento
 * Utilizza l'SDK ufficiale @unitn-asa/deliveroo-js-sdk
 * Include Automated Planning tramite PDDL (Lab 5) e BFS locale
 */

import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { onlineSolver, Beliefset } from "@unitn-asa/pddl-client";

const socket = DjsConnect();

const USE_PDDL = false; 

class MinHeap {
    constructor() { 
        this.heap = []; 
    }

    push(node) {
        this.heap.push(node);
        this.bubbleUp(this.heap.length - 1);
    }

    pop() {
        if (this.heap.length === 0) return null;
        if (this.heap.length === 1) return this.heap.pop();
        
        const min = this.heap[0];
        this.heap[0] = this.heap.pop();
        this.sinkDown(0);
        return min;
    }

    bubbleUp(index) {
        const element = this.heap[index];
        while (index > 0) {
            let parentIndex = Math.floor((index - 1) / 2);
            let parent = this.heap[parentIndex];
            
            if (element.f >= parent.f) break;
            
            this.heap[parentIndex] = element;
            this.heap[index] = parent;
            index = parentIndex;
        }
    }

    sinkDown(index) {
        const length = this.heap.length;
        const element = this.heap[index];
        while (true) {
            let leftChildIdx = 2 * index + 1;
            let rightChildIdx = 2 * index + 2;
            let leftChild, rightChild;
            let swap = null;

            if (leftChildIdx < length) {
                leftChild = this.heap[leftChildIdx];
                if (leftChild.f < element.f) swap = leftChildIdx;
            }
            
            if (rightChildIdx < length) {
                rightChild = this.heap[rightChildIdx];
                if (
                    (swap === null && rightChild.f < element.f) || 
                    (swap !== null && rightChild.f < leftChild.f)
                ) {
                    swap = rightChildIdx;
                }
            }
            
            if (swap === null) break;
            
            this.heap[index] = this.heap[swap];
            this.heap[swap] = element;
            index = swap;
        }
    }

    isEmpty() { 
        return this.heap.length === 0; 
    }
}

// BELIEFS
let myBeliefs = {
    me: /** @type {any} */ ({ id: null, x: undefined, y: undefined, score: 0 }),
    map: new Map(),      
    mapWidth: 0,
    mapHeight: 0,
    parcels: new Map(),  
    deliveryZones: [],
    spawnZones: [],      
    agents: new Map(),
    obstacles: new Map(),
    blacklistedTargets: new Map(),
    spawnActivity: new Map(),
    lastChecked: new Map(),
    currentPlan: /** @type {any} */ (null),
    config: {
        capacity: 5,
        vision: 5,
        clock: 50
    }
};

socket.on('connect', () => console.log("connected to server"));
socket.on('disconnect', () => console.log("disconnected from server! waiting for reconnection..."));

socket.on('config', (config) => {
    console.log("received server configuration");
    if (config.CLOCK) myBeliefs.config.clock = config.CLOCK;
    
    const playerConfig = (config.GAME && config.GAME.player) || config.PLAYER || {};
    if (playerConfig.capacity) myBeliefs.config.capacity = playerConfig.capacity;
    if (playerConfig.vision) myBeliefs.config.vision = playerConfig.vision;

    console.log(`updated rules -> backpack: ${myBeliefs.config.capacity}, vision: ${myBeliefs.config.vision}, Clock: ${myBeliefs.config.clock}ms`);
});

socket.on('map', (width, height, tiles) => {
    console.log(`Map size: ${width}x${height}`);
    myBeliefs.deliveryZones = []; 
    myBeliefs.spawnZones = [];
    myBeliefs.mapWidth = width;
    myBeliefs.mapHeight = height;
    
    tiles.forEach(t => {
        myBeliefs.map.set(`${t.x},${t.y}`, t.type);
        if (String(t.type) === '2' || t.type === 'delivery') {
            myBeliefs.deliveryZones.push({ x: t.x, y: t.y });
        }
        if (String(t.type) === '1' || t.type === 'parcel-spawning') {
            myBeliefs.spawnZones.push({ x: t.x, y: t.y });
            myBeliefs.spawnActivity.set(`${t.x},${t.y}`, Date.now());
        }
    });
    
    console.log(`deliveryZones: ${myBeliefs.deliveryZones.length}`);
});

// parcels
const handleParcels = (sensedParcels) => {
    if (sensedParcels && sensedParcels.length > 0) {
        console.log(` sensed ${sensedParcels.length} parcels!`);
    }

    const sensedIds = new Set();
    for (const p of sensedParcels) {
        const raw = p;
        const parcelObj = raw.parcel || raw; 
        if (parcelObj.id) sensedIds.add(parcelObj.id);
    }

    if (myBeliefs.me.x !== undefined) {
        for (let [id, p] of myBeliefs.parcels.entries()) {
            if (p.carriedBy !== myBeliefs.me.id) {
                const dist = Math.abs(p.x - Math.round(myBeliefs.me.x)) + Math.abs(p.y - Math.round(myBeliefs.me.y));
                if (dist < myBeliefs.config.vision && !sensedIds.has(id)) {
                    myBeliefs.parcels.delete(id);
                }
            }
        }
    }

    for (const p of sensedParcels) {
        const raw = p;
        const parcelObj = raw.parcel || raw;
        const id = parcelObj.id;
        
        if (id) {
            myBeliefs.parcels.set(id, { 
                id: id,
                x: raw.x !== undefined ? raw.x : parcelObj.x, 
                y: raw.y !== undefined ? raw.y : parcelObj.y, 
                reward: parcelObj.reward,
                carriedBy: parcelObj.carriedBy 
            });
            const key = `${myBeliefs.parcels.get(id).x},${myBeliefs.parcels.get(id).y}`;
            if (myBeliefs.spawnActivity.has(key)) {
                myBeliefs.spawnActivity.set(key, Date.now());
            }
        }
    }
};

// slides vs server, sides and server seems to differ in naming events
socket.on('parcelsSensing', handleParcels);
socket.on('parcels sensing', handleParcels);


// enemies perception
const handleAgents = (sensedAgents) => {
    myBeliefs.agents.clear();
    for (const a of sensedAgents) {
        if (a.id !== myBeliefs.me.id) {
            myBeliefs.agents.set(a.id, a);
        }
    }
};


// slides vs server, sides and server seems to differ in naming events
socket.on('agentsSensing', handleAgents);
socket.on('agents sensing', handleAgents);

// self perception 
socket.on('you', (me) => {
    myBeliefs.me = me;
});

async function resilientMove(direction, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        const result = await socket.emitMove(direction); 
        if (result) return result; 
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    await socket.emitShout(` Blocked trying to move ${direction}`); 
    return false;
}

function getRandomWalkableTile() {
    const walkableTiles = [];
    
    // We use the vision config dynamically
    const visionRange = myBeliefs.config.vision || 5;

    for (let [key, type] of myBeliefs.map.entries()) {
        if (String(type) !== '0') {
            const [x, y] = key.split(',').map(Number);
            
            if (getDistance(myBeliefs.me, {x, y}) > visionRange) {
                walkableTiles.push({ x, y, id: `explore_${x}_${y}` }); 
            }
        }
    }
    
    if (walkableTiles.length === 0) return null;
    
    return walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
}

async function agentLoop() {
    console.log("starting agent...");

    while (myBeliefs.deliveryZones.length === 0 || myBeliefs.me.x === undefined) {
        await new Promise(res => setTimeout(res, 100));
    }

    console.log(">>> initial data OK! agent starting...");

    let silentWaitCounter = 0;

    while (true) {
        try {
            await new Promise(res => setTimeout(res, myBeliefs.config.clock)); 

            const isCentered = Math.abs(myBeliefs.me.x - Math.round(myBeliefs.me.x)) <= 0.1 && 
                               Math.abs(myBeliefs.me.y - Math.round(myBeliefs.me.y)) <= 0.1;

            if (!isCentered) continue; 

            const now = Date.now();
            myBeliefs.lastChecked = myBeliefs.lastChecked || new Map();
            for (const zone of myBeliefs.spawnZones) {
                // Se la zona di spawn è nel nostro campo visivo, registriamo di averla vista ORA
                if (getDistance(myBeliefs.me, zone) <= myBeliefs.config.vision) {
                    myBeliefs.lastChecked.set(`${zone.x},${zone.y}`, now);
                }
            }
            for (let [key, timestamp] of myBeliefs.obstacles.entries()) {
                if (now - timestamp > 3000) { 
                    myBeliefs.obstacles.delete(key);
                }
            }

            let target = null;
            let intention = null;

            const myCarriedParcels = Array.from(myBeliefs.parcels.values())
                                          .filter(p => p.carriedBy === myBeliefs.me.id);

           if (myBeliefs.currentPlan && myBeliefs.currentPlan.steps.length > 0) {
                const tId = myBeliefs.currentPlan.targetId;
                
                if (tId === 'delivery') {
                    target = getClosest(myBeliefs.me, myBeliefs.deliveryZones);
                    intention = 'deliver';
                } else if (tId === 'patrol' || tId === 'explore') {
                    target = myBeliefs.currentPlan.target;
                    intention = tId;
                } else if (tId.startsWith('p')) {
                    let plannedParcel = myBeliefs.parcels.get(tId);
                    if (plannedParcel && !plannedParcel.carriedBy) {
                        target = plannedParcel;
                        intention = 'pickup';
                    } else {
                        myBeliefs.currentPlan = null;
                    }
                }
            }

            //soft commitment
            let shouldInvalidate = false;
            const bestAvailable = getBestParcel();

            if (bestAvailable) {
                if (intention === 'explore' || intention === 'patrol' || intention === null) {
                    // Abbandona subito l'esplorazione se vedi un pacco!
                    console.log(`>>> Pacco avvistato (${bestAvailable.id})! Interrompo ${intention || 'attesa'}.`);
                    shouldInvalidate = true;
                } else if (myBeliefs.currentPlan && intention === 'pickup' && target) {
                    let plannedParcel = myBeliefs.parcels.get(target.id);
                    
                    if (!plannedParcel || (plannedParcel.carriedBy && plannedParcel.carriedBy !== myBeliefs.me.id)) {
                        console.log(`>>> Target ${target.id} was taken or vanished. Aborting plan.`);
                        shouldInvalidate = true;
                    } else if (bestAvailable.id !== target.id) {
                        // Logica Dinamica: calcola i range in base alla visione
                        const closeRange = Math.max(2, Math.floor(myBeliefs.config.vision * 0.4));
                        const midRange = myBeliefs.config.vision;

                        let currentDistToTarget = getDistance(myBeliefs.me, plannedParcel);
                        if (currentDistToTarget === 0) currentDistToTarget = 0.1;
                        let currentClosestDel = getClosest(plannedParcel, myBeliefs.deliveryZones);
                        let currentDistToDel = getDistance(plannedParcel, currentClosestDel);
                        let currentScore = plannedParcel.reward / (currentDistToTarget + currentDistToDel);

                        let bestDistToTarget = getDistance(myBeliefs.me, bestAvailable);
                        if (bestDistToTarget === 0) bestDistToTarget = 0.1;
                        let bestClosestDel = getClosest(bestAvailable, myBeliefs.deliveryZones);
                        let bestDistToDel = getDistance(bestAvailable, bestClosestDel);
                        let bestScore = bestAvailable.reward / (bestDistToTarget + bestDistToDel);

                        let commitmentMultiplier = 1.3;
                        if (currentDistToTarget <= closeRange) {
                            commitmentMultiplier = 2.5;
                        } else if (currentDistToTarget <= midRange) {
                            commitmentMultiplier = 1.6;
                        }

                        if (bestScore > (currentScore * commitmentMultiplier)) {
                            console.log(`>>> New parcel spotted (${bestAvailable.id}). Better by factor ${commitmentMultiplier}.`);
                            shouldInvalidate = true;
                        }
                    }
                }
            } else if (intention === 'pickup' && (!target || myBeliefs.parcels.get(target.id)?.carriedBy)) {
                shouldInvalidate = true;
            }

            if (shouldInvalidate) {
                myBeliefs.currentPlan = null;
                target = null;
                intention = null;
            }

            // Wait & Hope (and dreams)
            if (!target) {
                let closestDelivery = getClosest(myBeliefs.me, myBeliefs.deliveryZones);

                if (myCarriedParcels.length >= myBeliefs.config.capacity || (myCarriedParcels.length > 0 && !bestAvailable)) {
                    target = closestDelivery;
                    intention = 'deliver';
                } else if (bestAvailable) {
                    target = bestAvailable;
                    intention = 'pickup';
                } else if (myBeliefs.spawnZones.length > 0) {
                    target = getBestSpawnZone();
                    intention = 'patrol';
                } else {
                    target = getRandomWalkableTile();
                    intention = 'explore';
                }
            }

            if (!target) {
                if (silentWaitCounter % 20 === 0) { 
                    console.log("No target, nowhere to go. Waiting...");
                }
                silentWaitCounter++;
                await new Promise(resolve => setTimeout(resolve, 50));
                continue;
            }

            // plan generation
            const targetId = intention === 'pickup' ? target.id : (intention === 'deliver' ? 'delivery' : intention);

            if (!myBeliefs.currentPlan || myBeliefs.currentPlan.targetId !== targetId || myBeliefs.currentPlan.steps.length === 0) {
                let newPlan;
                
                if (USE_PDDL) {
                    newPlan = await generatePddlPlan(myBeliefs.me, target, intention);
                } else {
                    newPlan = generateAStarPlan(myBeliefs.me, target);
                    
                    if (newPlan !== null) {
                        if (intention === 'pickup') {
                            newPlan.push('pick_up');
                        } else if (intention === 'deliver') {
                            newPlan.push('put_down');
                        }
                    }
                }

                if (newPlan !== null) {
                    if (newPlan.length === 0) {
                        if (intention === 'patrol' || intention === 'explore') {
                            console.log(`Reached ${intention} location, recalculating...`);
                            myBeliefs.currentPlan = null; // Forza la ricerca di una nuova cella al prossimo loop
                            await new Promise(resolve => setTimeout(resolve, 100));
                            continue;
                        } else {
                            silentWaitCounter++;
                            await new Promise(resolve => setTimeout(resolve, 500));
                            continue;
                        }
                    }
                    
                    console.log(`Generated plan for ${intention}! Steps: ${newPlan.length}`);
                    myBeliefs.currentPlan = { targetId: targetId, target: target, steps: newPlan };
                    silentWaitCounter = 0;
                } else {
                    console.log(`Nessun percorso per ${intention}. Forse c'è un ingorgo o è temporaneamente bloccato. Attendo...`);
                    myBeliefs.currentPlan = null;
                    
                    let blacklistKey = target.id || `${Math.round(target.x)},${Math.round(target.y)}`;
                    console.log(`Blacklisting target ${blacklistKey} per 15 secondi per evitare loop infiniti.`);
                    myBeliefs.blacklistedTargets.set(blacklistKey, Date.now());
                    
                    await new Promise(res => setTimeout(res, 500));
                    continue;
                }
            }

            // plan exectution
            const nextAction = myBeliefs.currentPlan.steps[0];
            let success = false;

            if (nextAction === 'pick_up') {
                await socket.emitPickup(); 
                let p = myBeliefs.parcels.get(target.id);
                if (p) p.carriedBy = myBeliefs.me.id;
                success = true;
                await new Promise(resolve => setTimeout(resolve, 100));
            } else if (nextAction === 'put_down') {
                await socket.emitPutdown();
                for (let [id, p] of myBeliefs.parcels) {
                    if (p.carriedBy === myBeliefs.me.id) myBeliefs.parcels.delete(id);
                }
                success = true;
                await new Promise(resolve => setTimeout(resolve, 100));
            } else {
                let targetX = Math.round(myBeliefs.me.x);
                let targetY = Math.round(myBeliefs.me.y);
                if (nextAction === 'up') targetY += 1;
                if (nextAction === 'down') targetY -= 1;
                if (nextAction === 'left') targetX -= 1;
                if (nextAction === 'right') targetX += 1;

                let isAgentBlocking = false;
                for (const agent of myBeliefs.agents.values()) {
                    if (Math.round(agent.x) === targetX && Math.round(agent.y) === targetY) {
                        isAgentBlocking = true;
                        break;
                    }
                }

                if (isAgentBlocking) {
                    if (myBeliefs.currentPlan.stuckCount === undefined) myBeliefs.currentPlan.stuckCount = 0;
                    myBeliefs.currentPlan.stuckCount++;

                    if (myBeliefs.currentPlan.stuckCount > 4) {
                        console.log(`>>> agent stuck. recalculating...`);
                        myBeliefs.currentPlan = null;
                    } else {
                        console.log(`enemy ahead. waiting...`);
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                    continue; 
                }

                if (myBeliefs.currentPlan) myBeliefs.currentPlan.stuckCount = 0;
                
                success = await resilientMove(nextAction); 
            }

            if (success) {
                myBeliefs.currentPlan.steps.shift();
            } else {
                console.log(`Mossa fallita: ${nextAction}. Ricalcolo...`);
                myBeliefs.currentPlan = null; 
                
                if (nextAction !== 'pick_up' && nextAction !== 'put_down') {
                    let ox = Math.round(myBeliefs.me.x);
                    let oy = Math.round(myBeliefs.me.y);
                    if (nextAction === 'up') oy += 1;
                    if (nextAction === 'down') oy -= 1;
                    if (nextAction === 'left') ox -= 1;
                    if (nextAction === 'right') ox += 1;
                    myBeliefs.obstacles.set(`${ox},${oy}`, Date.now());
                }
                continue;
            }
            
        } catch (error) {
            console.log(`loop error (${error.message}). retrying...`);
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

// possible bfs, switched to A* tho
function generateBfsPlan(start, target) {
    const startX = Math.round(start.x);
    const startY = Math.round(start.y);
    const targetX = Math.round(target.x);
    const targetY = Math.round(target.y);

    const queue = [{ x: startX, y: startY, path: [] }];
    const visited = new Set();
    visited.add(`${startX},${startY}`);

    while (queue.length > 0) {
        const current = queue.shift();

        if (current.x === targetX && current.y === targetY) {
            // @ts-ignore
            return current.path;
        }

        const dirs = [
            { dir: 'up', dx: 0, dy: 1 }, { dir: 'down', dx: 0, dy: -1 },
            { dir: 'right', dx: 1, dy: 0 }, { dir: 'left', dx: -1, dy: 0 }
        ];

        for (let d of dirs) {
            const nx = current.x + d.dx;
            const ny = current.y + d.dy;
            const key = `${nx},${ny}`;

            if (myBeliefs.obstacles.has(key)) continue; 

            if (!visited.has(key)) {
                const tileType = myBeliefs.map.get(key);
                
                if (tileType !== undefined && String(tileType) !== '0') {
                    let isOccupiedByAgent = false;
                    for (const agent of myBeliefs.agents.values()) {
                        if (Math.round(agent.x) === nx && Math.round(agent.y) === ny) {
                            if (!(nx === targetX && ny === targetY)) isOccupiedByAgent = true;
                            break;
                        }
                    }

                    if (!isOccupiedByAgent) {
                        visited.add(key);
                        // @ts-ignore
                        queue.push({ x: nx, y: ny, path: [...current.path, d.dir] });
                    }
                }
            }
        }
    }
    return null;
}

function generateAStarPlan(start, target) {
    const startX = Math.round(start.x);
    const startY = Math.round(start.y);
    const targetX = Math.round(target.x);
    const targetY = Math.round(target.y);

    // Heuristic: Manhattan Distance
    const getHeuristic = (x, y) => Math.abs(x - targetX) + Math.abs(y - targetY);

    const openSet = new MinHeap();
    openSet.push({ 
        x: startX, 
        y: startY, 
        g: 0, 
        f: getHeuristic(startX, startY), 
        path: [] 
    });

    //keeps track of the cheapest path found so far to any given tile
    const gScores = new Map();
    gScores.set(`${startX},${startY}`, 0);

    //Loop until the heap is empty
    while (!openSet.isEmpty()) {
        
        const current = openSet.pop();

        if (current.x === targetX && current.y === targetY) {
            return current.path;
        }

        const currentTileType = String(myBeliefs.map.get(`${current.x},${current.y}`));

        let allowedDirs = [
            { dir: 'up', dx: 0, dy: 1 }, 
            { dir: 'down', dx: 0, dy: -1 },
            { dir: 'right', dx: 1, dy: 0 }, 
            { dir: 'left', dx: -1, dy: 0 }
        ];


        for (let d of allowedDirs) {
            const nx = current.x + d.dx;
            const ny = current.y + d.dy;
            const key = `${nx},${ny}`;

            if (myBeliefs.obstacles.has(key)) continue; 

            const tileTypeRaw = myBeliefs.map.get(key);
            if (tileTypeRaw === undefined || String(tileTypeRaw) === '0') continue;

            const targetTileStr = String(tileTypeRaw);
            
            if (d.dir === 'left' && targetTileStr === '→') continue;
            if (d.dir === 'right' && targetTileStr === '←') continue;
            if (d.dir === 'up' && targetTileStr === '↓') continue;
            if (d.dir === 'down' && targetTileStr === '↑') continue;

            let isOccupiedByAgent = false;
            for (const agent of myBeliefs.agents.values()) {
                if (Math.round(agent.x) === nx && Math.round(agent.y) === ny) {
                    if (!(nx === targetX && ny === targetY)) {
                        isOccupiedByAgent = true;
                        break;
                    }
                }
            }

            const stepCost = isOccupiedByAgent ? 15 : 1;

            const tentativeG = current.g + stepCost;

            if (!gScores.has(key) || tentativeG < gScores.get(key)) {
                gScores.set(key, tentativeG);
                
                const fScore = tentativeG + getHeuristic(nx, ny);
                
                openSet.push({ 
                    x: nx, 
                    y: ny, 
                    g: tentativeG, 
                    f: fScore, 
                    path: [...current.path, d.dir] 
                });
            }
        }
    }
    
    return null;
}

function getDistance(pos1, pos2) {
    if (!pos1 || !pos2) return Infinity;
    return Math.abs(Math.round(pos1.x) - Math.round(pos2.x)) + Math.abs(Math.round(pos1.y) - Math.round(pos2.y));
}

function getClosest(pos, locations) {
    let minDest = Infinity;
    let closest = null;
    locations.forEach(loc => {
        const d = getDistance(pos, loc);
        if (d < minDest) {
            minDest = d;
            closest = loc;
        }
    });
    return closest;
}

function getBestSpawnZone() {
    if (myBeliefs.spawnZones.length === 0) return null;

    myBeliefs.lastChecked = myBeliefs.lastChecked || new Map();
    let bestZone = null;
    let bestScore = Infinity; 
    const now = Date.now();

    for (const zone of myBeliefs.spawnZones) {
        let distToZone = getDistance(myBeliefs.me, zone);
        
        let opponentsNearby = 0;
        for (const agent of myBeliefs.agents.values()) {
            if (getDistance(zone, agent) <= 4) opponentsNearby++;
        }

        let checkedTime = myBeliefs.lastChecked.get(`${zone.x},${zone.y}`) || 0;
        let timeSinceChecked = now - checkedTime; 
        
        let checkPenalty = 0;
        
        if (timeSinceChecked < 20000) { 
            checkPenalty = 1000;
        } else {
            checkPenalty = -Math.min(timeSinceChecked / 1000, 50); 
        }

        let score = distToZone + (opponentsNearby * 15) + checkPenalty;

        if (score < bestScore) {
            bestScore = score;
            bestZone = zone;
        }
    }

    if (bestScore > 500) {
        return null;
    }

    return bestZone;
}

function getBestParcel() {
    let best = null;
    let bestScore = -Infinity;

    const myCarriedParcels = Array.from(myBeliefs.parcels.values())
                                  .filter(p => p.carriedBy === myBeliefs.me.id);
    const isCarrying = myCarriedParcels.length > 0;
    
    const targetDeliveryZone = getClosest(myBeliefs.me, myBeliefs.deliveryZones);

    for (let p of myBeliefs.parcels.values()) {
        if (p.carriedBy) continue;
        const blacklistedAt = myBeliefs.blacklistedTargets.get(p.id);
        const now = Date.now();
        if (blacklistedAt && now - blacklistedAt < 15000) continue;

        let distToParcel = getDistance(myBeliefs.me, p);
        if (distToParcel === 0) distToParcel = 0.1;

        let currentScore;

        if (isCarrying && targetDeliveryZone) {

            let directPath = getDistance(myBeliefs.me, targetDeliveryZone);
            let pathWithDetour = getDistance(myBeliefs.me, p) + getDistance(p, targetDeliveryZone);
            
            let detourCost = pathWithDetour - directPath;
            
            if (detourCost <= 0) detourCost = 0.1;

            currentScore = p.reward / detourCost;

        } else {
            let closestDelivery = getClosest(p, myBeliefs.deliveryZones);
            let distToDelivery = getDistance(p, closestDelivery);
            currentScore = p.reward / (distToParcel + distToDelivery);
        }

        if (!best || currentScore > bestScore) {
            best = p;
            bestScore = currentScore;
        }
    }
    return best;
}

async function emitRandomMove() {
    /** @type {Array<'up'|'down'|'left'|'right'>} */
    const dirs = ['up', 'down', 'left', 'right'];
    const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
    await socket.emitMove(randomDir);
}

agentLoop();