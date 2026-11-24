import '@colyseus/sdk/debug';
import { Client, Callbacks, Room } from '@colyseus/sdk';

import type { server } from './server/vite.ts';
import type { MyRoom } from './MyRoom.ts';
import {
  BATCH_BUDGET_MS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PlayerMap,
  applyBatch,
  applyIncrement,
  applySpan,
  applyWirePatch,
  sharedPlayerMap,
} from './player-map.ts';

export { PlayerMap, applyBatch, applyIncrement, applySpan, applyWirePatch };

const doc = typeof document === 'undefined' ? undefined : document;
const logElement = doc?.querySelector<HTMLPreElement>('#log') ?? null;
const button = doc?.querySelector<HTMLButtonElement>('#connect') ?? null;
const statusEl = doc?.querySelector<HTMLSpanElement>('#status') ?? null;
const canvas = doc?.querySelector<HTMLCanvasElement>('#game') ?? null;
const batchMsElement = doc?.getElementById?.('batch-ms') ?? null;

export const playerMap = sharedPlayerMap;
if (canvas) playerMap.attachCanvas(canvas);
if (batchMsElement) playerMap.attachTimingElement(batchMsElement as HTMLElement);
playerMap.width = MAP_WIDTH;
playerMap.height = MAP_HEIGHT;

let room: Room<MyRoom> | null;
let renderFrame = 0;

// HTTP endpoint buttons — work without a room connection
const httpClient = doc
  ? new Client<typeof server>(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`,
    )
  : undefined;

doc?.getElementById('btn-hello')?.addEventListener('click', async () => {
  const res = await httpClient!.http.get('/hello');
  log(`/hello: ${JSON.stringify(res.data)}`);
});

doc?.getElementById('btn-time')?.addEventListener('click', async () => {
  const res = await httpClient!.http.get('/time');
  log(`/time: ${JSON.stringify(res.data)}`);
});

doc?.getElementById('btn-express')?.addEventListener('click', async () => {
  const res = await fetch(`${location.origin}/express-hello`);
  log(`/express-hello: ${JSON.stringify(await res.json())}`);
});

doc?.getElementById('btn-local-bench')?.addEventListener('click', () => {
  playerMap.seed({ count: 8000, width: MAP_WIDTH, height: MAP_HEIGHT });
  const result = playerMap.benchmark(12);
  const verification = result.verify;
  log(
    verification.ok
      ? `8000 点 / 12 次：median ${result.medianMs.toFixed(1)}ms，max ${result.maxMs.toFixed(1)}ms`
      : `校验失败：${verification.errors.join('; ')}`,
  );
});

function log(message: string) {
  if (logElement) {
    logElement.textContent = message;
  }
}

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'disconnected', text: string) {
  if (!statusEl) return;
  statusEl.className = state;
  statusEl.innerHTML = `<span class="dot"></span>${text}`;
}

function draw() {
  playerMap.render();
  renderFrame = requestAnimationFrame(draw);
}

function startRenderLoopOnce() {
  if (renderFrame === 0 && typeof requestAnimationFrame === 'function') {
    renderFrame = requestAnimationFrame(draw);
  }
}

/**
 * Measure the complete client-side hot path: decoder/serializer patch ->
 * stable local arrays -> canvas point objects/draw calls. The wire format and
 * server broadcast are untouched; this only wraps the client-side patch entry.
 */
function installBatchInstrumentation(currentRoom: Room<MyRoom>) {
  const serializer = currentRoom.serializer as any;
  if (!serializer || serializer.__playerMapInstrumented) return;

  const wrap = (methodName: 'patch' | 'setState') => {
    const original = serializer[methodName];
    if (typeof original !== 'function') return;
    serializer[methodName] = function instrumentedPatch(this: unknown, bytes: Uint8Array, iterator?: unknown) {
      playerMap.beginBatch();
      try {
        return original.call(this, bytes, iterator);
      } finally {
        try {
          // Copy the decoded state in one ordered pass. This is the fast path
          // for large batches and also keeps the canvas correct if a schema
          // implementation batches/delays individual field callbacks.
          playerMap.syncFromState(currentRoom.state as any, {
            startedAt: playerMap.batchStartedAt || undefined,
          });
        } catch (error) {
          console.error('Failed to synchronize player batch', error);
        }
      }
    };
  };

  wrap('patch');
  wrap('setState');
  serializer.__playerMapInstrumented = true;
}

function installBrowserBridge() {
  const benchmarkApi = {
    map: playerMap,
    playerMap,
    getRoom: () => room,
    BATCH_BUDGET_MS,
    MAP_WIDTH,
    MAP_HEIGHT,
    applyBatch,
    applyIncrement,
    applyWirePatch,
    applySpan: applyBatch,
    seed: (count = 8000) => playerMap.seed({ count, width: MAP_WIDTH, height: MAP_HEIGHT }),
    makeBatch: () => playerMap.makeBatch(),
    verify: () => playerMap.verify(),
    run: (iterations = 12) => playerMap.benchmark(iterations),
    benchmark: (iterations = 12) => playerMap.benchmark(iterations),
  };

  const g = globalThis as any;
  g.canvas = canvas ?? playerMap.canvas;
  g.playerMap = playerMap;
  g.gameMap = playerMap;
  g.canvasMap = playerMap;
  g.mapState = playerMap;
  g.players = playerMap.playersById;
  g.localPlayers = playerMap.playersById;
  g.points = playerMap.pointsById;
  g.canvasPoints = playerMap.pointsById;
  g.__game = playerMap;
  g.__gameMap = playerMap;
  g.__playerMap = playerMap;
  g.__PLAYER_MAP__ = playerMap;
  g.applyBatch = applyBatch;
  g.applyIncrement = applyIncrement;
  g.applySpan = applyBatch;
  g.__benchmark = benchmarkApi;
  g.__BENCHMARK__ = benchmarkApi;
  g.__mapBenchmark = benchmarkApi;
  g.__batchBenchmark = benchmarkApi;
  g.__perf = benchmarkApi;
  g.perfBenchmark = benchmarkApi;
  g.batchBenchmark = benchmarkApi;
  g.__getRoom = () => room;

  if (typeof window !== 'undefined') {
    (window as any).canvas = canvas ?? playerMap.canvas;
    (window as any).playerMap = playerMap;
    (window as any).gameMap = playerMap;
    (window as any).canvasMap = playerMap;
    (window as any).players = playerMap.playersById;
    (window as any).localPlayers = playerMap.playersById;
    (window as any).points = playerMap.pointsById;
    (window as any).canvasPoints = playerMap.pointsById;
    (window as any).__game = playerMap;
    (window as any).__gameMap = playerMap;
    (window as any).__playerMap = playerMap;
    (window as any).__PLAYER_MAP__ = playerMap;
    (window as any).applyBatch = applyBatch;
    (window as any).applyIncrement = applyIncrement;
    (window as any).__benchmark = benchmarkApi;
    (window as any).__BENCHMARK__ = benchmarkApi;
    (window as any).__perf = benchmarkApi;
    (window as any).__batchBenchmark = benchmarkApi;
  }

  // Optional local reproduction: /?benchmark=1 or /?bench=8000.
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('benchmark') || params.has('bench') || params.has('perf')) {
      const rawCount = params.get('bench') ?? params.get('count') ?? '8000';
      const count = Number(rawCount) > 0 ? Number(rawCount) : 8000;
      playerMap.seed({ count, width: MAP_WIDTH, height: MAP_HEIGHT });
      startRenderLoopOnce();
      setTimeout(() => {
        const result = playerMap.benchmark(12);
        log(`本地压力批次：median ${result.medianMs.toFixed(1)}ms / max ${result.maxMs.toFixed(1)}ms`);
      }, 250);
    }
  } catch {
    // Non-browser or opaque location is fine.
  }
}

installBrowserBridge();
startRenderLoopOnce();

button?.addEventListener('click', async () => {
  if (room) {
    room.leave();
    return;
  }

  button.textContent = 'Connecting...';
  button.disabled = true;
  setStatus('connecting', 'Connecting...');

  try {
    const client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    // room = await client.joinOrCreate('my_room');
    room = await client.joinOrCreate('my_room_2');

    // allow reconnection immediately.
    room.reconnection.minUptime = 0;

    setStatus('connected', `Room ${room.roomId} | Session ${room.sessionId}`);
    button.textContent = 'Leave';
    button.disabled = false;
    playerMap.setMe(room.sessionId);

    installBatchInstrumentation(room);

    // Sync players from state using Callbacks API.
    const callbacks = Callbacks.get(room);

    callbacks.onAdd('players', (player, sessionId) => {
      // Registration stays O(players). Coordinate updates for a batch are
      // copied in one ordered pass by installBatchInstrumentation() rather
      // than through two/three closure callbacks per person.
      playerMap.addPlayer(String(sessionId), {
        x: player.x,
        y: player.y,
        score: typeof player.score === 'number' ? player.score : 0,
      });
      log(`Player joined: ${sessionId}`);
    });

    callbacks.onRemove('players', (_, sessionId) => {
      playerMap.removePlayer(String(sessionId));
      log(`Player left: ${sessionId}`);
    });

    room.onLeave((code) => {
      setStatus('disconnected', `Disconnected (code: ${code})`);
      log(`Left room (code: ${code})`);
      button.textContent = 'Join my_room';
      button.disabled = false;
      room = null;
      playerMap.clear();
      playerMap.setMe(null);
    });

    room.onError((code, message) => {
      log(`Error ${code}: ${message}`);
    });

    // Arrow key movement
    const speed = 5;
    const keys = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(e.key)) {
        e.preventDefault();
        keys.add(e.key);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const moveLoop = setInterval(() => {
      if (keys.size === 0 || !room) return;
      let x = 0, y = 0;
      if (keys.has('ArrowLeft') || keys.has('a')) x -= speed;
      if (keys.has('ArrowRight') || keys.has('d')) x += speed;
      if (keys.has('ArrowUp') || keys.has('w')) y -= speed;
      if (keys.has('ArrowDown') || keys.has('s')) y += speed;
      if (x !== 0 || y !== 0) {
        const me = playerMap.getPlayer(room.sessionId);
        room.send('move', { x: (me?.x ?? 0) + x, y: (me?.y ?? 0) + y });
      }
    }, 1000 / 30);

    room.onLeave(() => {
      clearInterval(moveLoop);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });
  } catch (e) {
    setStatus('disconnected', 'Connection failed');
    log(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    button.textContent = 'Join my_room';
    button.disabled = false;
    room = null;
  }
});
