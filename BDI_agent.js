// BDI agent entry point. All logic lives under agents/.

import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { GameClient } from './agents/common/GameClient.js';
import { AsaProtocol } from './agents/common/AsaProtocol.js';
import { BdiAgent } from './agents/bdi/BdiAgent.js';

const socket = DjsConnect();
const client = new GameClient(socket);
const asa    = new AsaProtocol(client);
const agent  = new BdiAgent({ client, asa });

client.on('connect',    () => console.log('[bdi-entry] connected to game server'));
client.on('disconnect', () => console.log('[bdi-entry] disconnected, waiting for reconnect'));

agent.start();
