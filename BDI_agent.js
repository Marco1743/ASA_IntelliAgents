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

//true to use the external planner, false to use local code
//local code is way faster and better. PDDL is required i think(?)
const USE_PDDL = false; 

// BELIEFS
let myBeliefs = {
    me: /** @type {any} */ ({ id: null, x: 0, y: 0, score: 0 }),
    map: new Map(),      
    parcels: new Map(),  
    deliveryZones: [],
    spawnZones: [],      
    agents: new Map(),
    obstacles: new Map(),
    currentPlan: /** @type {any} */ (null),
    
    // rules config , these are defaults but the code update them with the server config if provided
    config: {
        capacity: 5,
        vision: 5,
        clock: 50
    }
};

// connection to the server, to chose the server modify the .env file
socket.on('connect', () => console.log("Connesso al server!"));
socket.on('disconnect', () => console.log("Disconnesso dal server! In attesa di riconnessione..."));
// update of game rules
socket.on('config', (config) => {
    console.log("Ricevuta configurazione del server!");
    if (config.CLOCK) myBeliefs.config.clock = config.CLOCK;
    
    const playerConfig = (config.GAME && config.GAME.player) || config.PLAYER || {};
    if (playerConfig.capacity) myBeliefs.config.capacity = playerConfig.capacity;
    if (playerConfig.vision) myBeliefs.config.vision = playerConfig.vision;

    console.log(`updated rules -> backpack: ${myBeliefs.config.capacity}, vision: ${myBeliefs.config.vision}, Clock: ${myBeliefs.config.clock}ms`);
});

// world perception

//mpa structure
socket.on('map', (width, height, tiles) => {
    console.log(`Map size: ${width}x${height}`);
    myBeliefs.deliveryZones = []; 
    myBeliefs.spawnZones = [];
    
    tiles.forEach(t => {
        myBeliefs.map.set(`${t.x},${t.y}`, t.type);
        if (String(t.type) === '2' || t.type === 'delivery') {
            myBeliefs.deliveryZones.push({ x: t.x, y: t.y });
        }
        if (String(t.type) === '1' || t.type === 'parcel-spawning') {
            myBeliefs.spawnZones.push({ x: t.x, y: t.y });
        }
    });
});

// finding food
socket.on('parcels sensing', (sensedParcels) => {
    const sensedIds = new Set();
    for (const p of sensedParcels) {
        const raw = /** @type {any} */ (p);
        const parcelObj = raw.parcel || raw;
        if (parcelObj.id) sensedIds.add(parcelObj.id);
    }

    // clean up of parcerls that were in beliefs but ar no more visible
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

    // food belief update
    for (const p of sensedParcels) {
        const raw = /** @type {any} */ (p);
        const parcelObj = raw.parcel || raw;
        const id = parcelObj.id;
        
        if (id) {
            myBeliefs.parcels.set(id, { 
                id: id, 
                x: raw.x, 
                y: raw.y, 
                reward: parcelObj.reward,
                carriedBy: parcelObj.carriedBy 
            });
        }
    }
});

// enemies perception
socket.on('agents sensing', (sensedAgents) => {
    myBeliefs.agents.clear();
    for (const a of sensedAgents) {
        if (a.id !== myBeliefs.me.id) {
            myBeliefs.agents.set(a.id, a);
        }
    }
});

// self perception
socket.on('you', (me) => {
    myBeliefs.me = me;
});


// agent loop
async function agentLoop() {
    console.log("starting agent...");

    while (myBeliefs.deliveryZones.length === 0 || myBeliefs.me.x === undefined) {
        await new Promise(res => setTimeout(res, 100));
    }

    while (true) {
        try {
            await new Promise(res => setTimeout(res, myBeliefs.config.clock)); 

            // to avoid issues of server desynch, we wait to be centred in a tile before going on
            const isCentered = Math.abs(myBeliefs.me.x - Math.round(myBeliefs.me.x)) <= 0.1 && 
                               Math.abs(myBeliefs.me.y - Math.round(myBeliefs.me.y)) <= 0.1;

            if (!isCentered) continue; 

            // cleaup of dynamic obstacles, remove after 3 seonds but we could maybe adjust it to be dynamic 
            const now = Date.now();
            for (let [key, timestamp] of myBeliefs.obstacles.entries()) {
                if (now - timestamp > 3000) { 
                    myBeliefs.obstacles.delete(key);
                }
            }

            let target = null;
            let intention = null;

            // DESIRE & INTENTION
            const myCarriedParcels = Array.from(myBeliefs.parcels.values())
                                            .filter(p => p.carriedBy === myBeliefs.me.id);

            // if the plan is not finished we carry on
            if (myBeliefs.currentPlan && myBeliefs.currentPlan.steps.length > 0) {
                const tId = myBeliefs.currentPlan.targetId;
                
                if (tId === 'delivery') {
                    // we are ging to delivery
                    target = getClosest(myBeliefs.me, myBeliefs.deliveryZones);
                    intention = 'deliver';
                } else if (tId.startsWith('p')) {
                    // we are going to pick up food, we have to check it still exists
                    let plannedParcel = myBeliefs.parcels.get(tId);
                    if (plannedParcel && !plannedParcel.carriedBy) {
                        target = plannedParcel;
                        intention = 'pickup';
                    } else {
                        // if the package has been picked up by someone else or is no more, we have to replan
                        myBeliefs.currentPlan = null;
                    }
                }
            }

            // if we do not have a target yet or our plan has failed
            if (!target) {
                let bestFreeParcel = getBestParcel();
                let closestDelivery = getClosest(myBeliefs.me, myBeliefs.deliveryZones);

                // decision logic of target
                if (myCarriedParcels.length >= myBeliefs.config.capacity || (myCarriedParcels.length > 0 && !bestFreeParcel)) {
                    target = closestDelivery;
                    intention = 'deliver';
                } else if (bestFreeParcel) {
                    target = bestFreeParcel;
                    intention = 'pickup';
                } else if (myBeliefs.spawnZones.length > 0) {
                    target = getClosest(myBeliefs.me, myBeliefs.spawnZones);
                    intention = 'patrol';
                }
            }
            // once we have a target
            if (target) {
                const targetId = intention === 'pickup' ? target.id : (intention === 'deliver' ? 'delivery' : 'patrol');

                // we generate a plan
                if (!myBeliefs.currentPlan || myBeliefs.currentPlan.targetId !== targetId || myBeliefs.currentPlan.steps.length === 0) {
                    console.log(`generating a plan to ${intention}...`);
                    let newPlan;
                    
                    if (USE_PDDL) {
                        // if we put this to true we use the external planner, it is really slow and kinda "dumb" as for now, probably can retrieve better plans if we pass better target intentions
                        newPlan = await generatePddlPlan(myBeliefs.me, target, intention);
                    } else {
                        newPlan = generateBfsPlan(myBeliefs.me, target);
                    }

                    //update our plan
                    if (newPlan && newPlan.length > 0) {
                        myBeliefs.currentPlan = { targetId: targetId, steps: newPlan };
                    } else {
                        // if we cannot find a plan we mark it as an obstacle in order to avoid trying to rach it for a while
                        myBeliefs.currentPlan = null;
                        myBeliefs.obstacles.set(`${Math.round(target.x)},${Math.round(target.y)}`, Date.now());
                        continue;
                    }
                }

                // executing the plan
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
                    success = await socket.emitMove(nextAction); 
                }

                if (success) {
                    myBeliefs.currentPlan.steps.shift();
                } else {
                    // if the plan fails we calculate a new one
                    console.log(`plan failed, ${nextAction}. recalculating...`);
                    myBeliefs.currentPlan = null; 
                    
                    // logic to save dynamic obstacles found
                    if (nextAction !== 'pick_up') {
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
            }
            
        } catch (error) {
            // problems with the server
            console.log(`(${error.message}). retrying...`);
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}



// planning (BFS)(lab 4)
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


//planning external planner
const pddlDomainStr = `(define (domain deliveroo)
    (:requirements :strips)
    (:predicates
        (at ?t)
        (right ?t1 ?t2)
        (left ?t1 ?t2)
        (up ?t1 ?t2)
        (down ?t1 ?t2)
        (at-parcel ?p ?t)
        (carried ?p)
        (handsfree)
        (delivery-zone ?t)
    )
    (:action move_right
        :parameters (?from ?to)
        :precondition (and (at ?from) (right ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move_left
        :parameters (?from ?to)
        :precondition (and (at ?from) (left ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move_up
        :parameters (?from ?to)
        :precondition (and (at ?from) (up ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action move_down
        :parameters (?from ?to)
        :precondition (and (at ?from) (down ?from ?to))
        :effect (and (at ?to) (not (at ?from)))
    )
    (:action pick_up
        :parameters (?t ?p)
        :precondition (and (at ?t) (at-parcel ?p ?t) (handsfree))
        :effect (and (not (at-parcel ?p ?t)) (not (handsfree)) (carried ?p))
    )
    (:action put_down
        :parameters (?t)
        :precondition (and (at ?t) (delivery-zone ?t) (not (handsfree)))
        :effect (handsfree)
    )
)`;

async function generatePddlPlan(start, target, intention) {
    try {
        const myBeliefset = new Beliefset();
        const startX = Math.round(start.x);
        const startY = Math.round(start.y);
        const targetX = Math.round(target.x);
        const targetY = Math.round(target.y);

        myBeliefset.declare(`at t_${startX}_${startY}`);

        const myCarriedParcels = Array.from(myBeliefs.parcels.values()).filter(p => p.carriedBy === myBeliefs.me.id);
        if (myCarriedParcels.length === 0) {
            myBeliefset.declare(`handsfree`);
        }

        for (let [key, type] of myBeliefs.map.entries()) {
            if (String(type) === '0' || myBeliefs.obstacles.has(key)) continue;

            let [x, y] = key.split(',').map(Number);
            let rightKey = `${x+1},${y}`;
            if (myBeliefs.map.has(rightKey) && String(myBeliefs.map.get(rightKey)) !== '0' && !myBeliefs.obstacles.has(rightKey)) {
                myBeliefset.declare(`right t_${x}_${y} t_${x+1}_${y}`);
                myBeliefset.declare(`left t_${x+1}_${y} t_${x}_${y}`);
            }
            let upKey = `${x},${y+1}`;
            if (myBeliefs.map.has(upKey) && String(myBeliefs.map.get(upKey)) !== '0' && !myBeliefs.obstacles.has(upKey)) {
                myBeliefset.declare(`up t_${x}_${y} t_${x}_${y+1}`);
                myBeliefset.declare(`down t_${x}_${y+1} t_${x}_${y}`);
            }

            if (String(type) === '2' || type === 'delivery') {
                myBeliefset.declare(`delivery-zone t_${x}_${y}`);
            }
        }

        let pddlGoalStr = "";

        if (intention === 'pickup') {
            myBeliefset.declare(`at-parcel p_${target.id} t_${targetX}_${targetY}`);
            pddlGoalStr = `(:goal (and (carried p_${target.id})))`;
        } else if (intention === 'deliver') {
            pddlGoalStr = `(:goal (and (handsfree)))`;
        } else {
            pddlGoalStr = `(:goal (and (at t_${targetX}_${targetY})))`;
        }

        const pddlProblemStr = `(define (problem deliveroo_prob)
            (:domain deliveroo)
            (:objects ${myBeliefset.objects.join(' ')})
            (:init ${myBeliefset.toPddlString()})
            ${pddlGoalStr}
        )`;

        console.log("⏳ Chiamata al PDDL online solver in corso...");
        const rawPlan = await onlineSolver(pddlDomainStr, pddlProblemStr);
        
        if (rawPlan && !rawPlan.error && Array.isArray(rawPlan)) {
            const steps = rawPlan.map(step => step.action.toLowerCase().replace('move_', ''));
            console.log("obtained plan:", steps);
            return steps;
        } else {
            console.log("the external planner has not found a solution.");
            return null;
        }
    } catch (e) {
        console.error("Error API PDDL:", e.message);
        return null;
    }
}


//utils
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

function getBestParcel() {
    let best = null;
    let bestScore = -Infinity;

    for (let p of myBeliefs.parcels.values()) {
        if (p.carriedBy) continue;

        let distance = getDistance(myBeliefs.me, p);

        if (distance === 0) distance = 0.1;

        let currentScore = p.reward / distance;

        if (!best || currentScore > bestScore) {
            best = p;
            bestScore = currentScore;
        }
    }
    return best;
}

//if we are stuck
async function emitRandomMove() {
    /** @type {Array<'up'|'down'|'left'|'right'>} */
    const dirs = ['up', 'down', 'left', 'right'];
    const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
    await socket.emitMove(randomDir);
}

agentLoop();