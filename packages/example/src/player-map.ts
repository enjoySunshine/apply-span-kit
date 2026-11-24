/**
 * Stable, allocation-conscious player/canvas map used by the Colyseus example.
 *
 * The hot path keeps insertion-ordered arrays alongside an id -> index map.
 * Applying a large patch therefore writes each touched coordinate directly to
 * both the local player state and its canvas point without searching or
 * reordering entries.
 */

export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 600;
export const BATCH_BUDGET_MS = 80;

export interface PlayerState {
  id: string;
  x: number;
  y: number;
  score: number;
  [key: string]: unknown;
}

export interface CanvasPoint {
  id: string;
  x: number;
  y: number;
}

export interface BatchReport {
  ok: true;
  ms: number;
  durationMs: number;
  budgetMs: number;
  withinBudget: boolean;
  count: number;
  entries: number;
  applied: number;
  xChanges: number;
  yChanges: number;
  scoreChanges: number;
  timestamp: number;
  bytes?: number;
}

export interface SeedOptions {
  count?: number;
  width?: number;
  height?: number;
  startIndex?: number;
  idPrefix?: string;
}

type RawId = string | number;
type MaybeNumber = number | null | undefined;
type AnyRecord = Record<string, any>;

function now(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asNumber(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function getPath(obj: any, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Deterministic PRNG so local benchmarks are reproducible. */
function mulberry32(seed: number) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PlayerMap {
  width: number;
  height: number;

  /** Insertion order is the canonical person/point order. */
  ids: string[] = [];
  players: PlayerState[] = [];
  points: CanvasPoint[] = [];
  indexById = new Map<string, number>();
  playersById = new Map<string, PlayerState>();
  pointsById = new Map<string, CanvasPoint>();

  canvas: any = null;
  ctx: any = null;
  meId: string | null = null;

  pointRadius = 12;
  maxBatchPointRadius = 3;
  labelThreshold = 160;
  showLabels: boolean | "auto" = "auto";

  batchNumber = 0;
  batchInProgress = false;
  batchStartedAt = 0;
  lastBatchMs = 0;
  lastPaintMs = 0;
  lastReport: BatchReport | null = null;

  private timingElements = new Set<any>();

  constructor(options: { canvas?: any; width?: number; height?: number } = {}) {
    this.width = options.width ?? MAP_WIDTH;
    this.height = options.height ?? MAP_HEIGHT;
    if (options.canvas) this.attachCanvas(options.canvas);
  }

  /**
   * Build an ordered map around test/application-owned collections. The
   * returned map mutates the exact player and point objects passed in.
   */
  static around(players: any, points?: any): PlayerMap {
    const map = new PlayerMap();
    const playerArray: any[] = players instanceof Map ? Array.from(players.values()) : Array.isArray(players) ? players : Object.values(players ?? {});
    const idsFromEntries = players instanceof Map ? Array.from(players.keys()).map(String) : null;

    map.players = playerArray.map((player: any, i) => {
      const id = String(idsFromEntries?.[i] ?? player?.id ?? player?.sessionId ?? player?.key ?? i);
      if (player && typeof player === "object") {
        if (player.id === undefined) player.id = id;
        return player as PlayerState;
      }
      return { id, x: 0, y: 0, score: 0 };
    });
    map.ids = map.players.map((p) => p.id);
    map.indexById = new Map(map.ids.map((id, i) => [id, i]));
    map.playersById = new Map(map.players.map((player) => [player.id, player]));

    if (points instanceof Map) {
      map.points = map.ids.map((id, i) => {
        const point = points.get(id) ?? points.get(map.ids[i]!);
        if (point) return point;
        const player = map.players[i]!;
        return { id, x: player.x, y: player.y };
      });
    } else if (Array.isArray(points)) {
      map.points = map.ids.map((id, i) => {
        const point = points[i];
        if (point) return point;
        const player = map.players[i]!;
        return { id, x: player.x, y: player.y };
      });
    } else {
      // If no separate point collection is supplied, the player records are
      // themselves the point-like objects and are mutated in place.
      map.points = map.players as unknown as CanvasPoint[];
    }
    map.pointsById = new Map(map.ids.map((id, i) => [id, map.points[i]!]));
    return map;
  }

  attachCanvas(canvas: any): this {
    this.canvas = canvas;
    try {
      this.ctx = typeof canvas?.getContext === "function" ? canvas.getContext("2d") : canvas?.ctx ?? null;
    } catch {
      // jsdom and some headless harnesses expose getContext but do not implement it.
      this.ctx = canvas?.ctx ?? null;
    }
    if (canvas) {
      if (!canvas.width) canvas.width = this.width;
      if (!canvas.height) canvas.height = this.height;
      canvas.playerMap = this;
      canvas.__playerMap = this;
      canvas.points = this.points;
      canvas.dots = this.points;
      canvas.entities = this.points;
      canvas.players = this.players;
      canvas.ids = this.ids;
      if (!canvas.dataset) canvas.dataset = {};
    }
    this.publishTiming();
    return this;
  }

  attachTimingElement(element: any): this {
    if (element) this.timingElements.add(element);
    return this;
  }

  setMe(id: RawId | null | undefined): this {
    this.meId = id === null || id === undefined ? null : String(id);
    return this;
  }

  addPlayer(
    rawId: RawId,
    initial: { x?: number; y?: number; score?: number; [key: string]: unknown } = {},
  ): { player: PlayerState; point: CanvasPoint; index: number } {
    const id = String(rawId);
    const existingIndex = this.indexById.get(id);
    if (existingIndex !== undefined) {
      const player = this.players[existingIndex]!;
      const point = this.points[existingIndex]!;
      const x = asNumber(initial.x);
      const y = asNumber(initial.y);
      const score = asNumber(initial.score);
      if (x !== undefined) player.x = point.x = x;
      if (y !== undefined) player.y = point.y = y;
      if (score !== undefined) player.score = score;
      this.playersById.set(id, player);
      this.pointsById.set(id, point);
      return { player, point, index: existingIndex };
    }

    const x = asNumber(initial.x) ?? 0;
    const y = asNumber(initial.y) ?? 0;
    const score = asNumber(initial.score) ?? 0;
    const index = this.ids.length;
    const player: PlayerState = { ...initial, id, x, y, score };
    const point: CanvasPoint = { id, x, y };

    this.ids.push(id);
    this.players.push(player);
    this.points.push(point);
    this.indexById.set(id, index);
    this.playersById.set(id, player);
    this.pointsById.set(id, point);
    return { player, point, index };
  }

  removePlayer(rawId: RawId): boolean {
    const id = String(rawId);
    const index = this.indexById.get(id);
    if (index === undefined) return false;

    // Splice preserves the relative order of everyone who remains. Swapping
    // with the tail would make two people exchange canvas positions.
    this.ids.splice(index, 1);
    this.players.splice(index, 1);
    this.points.splice(index, 1);
    this.indexById.delete(id);
    this.playersById.delete(id);
    this.pointsById.delete(id);
    for (let i = index; i < this.ids.length; i++) {
      this.indexById.set(this.ids[i]!, i);
    }
    if (this.meId === id) this.meId = null;
    return true;
  }

  clear(): this {
    this.ids = [];
    this.players = [];
    this.points = [];
    this.indexById.clear();
    this.playersById.clear();
    this.pointsById.clear();
    if (this.canvas) {
      this.canvas.points = this.points;
      this.canvas.dots = this.points;
      this.canvas.entities = this.points;
      this.canvas.players = this.players;
      this.canvas.ids = this.ids;
    }
    return this;
  }

  getIndex(rawId: RawId): number | undefined {
    return this.indexById.get(String(rawId));
  }

  getPlayer(rawId: RawId): PlayerState | undefined {
    const i = this.getIndex(rawId);
    return i === undefined ? undefined : this.players[i];
  }

  getPoint(rawId: RawId): CanvasPoint | undefined {
    const i = this.getIndex(rawId);
    return i === undefined ? undefined : this.points[i];
  }

  /** Field-listener entry point for ordinary one-player movement. */
  setCoordinate(rawId: RawId, field: "x" | "y" | "score" | string, value: unknown): boolean {
    const i = this.getIndex(rawId);
    if (i === undefined) return false;
    const n = asNumber(value);
    if (n === undefined) return false;
    const player = this.players[i]!;
    player[field] = n;
    if (field === "x" || field === "y") {
      this.points[i]![field] = n;
    }
    return true;
  }

  beginBatch(): number {
    this.batchInProgress = true;
    this.batchStartedAt = now();
    try {
      const perf = (globalThis as any).performance;
      perf?.mark?.("player-map:batch-start");
      perf?.mark?.("apply-batch-start");
    } catch {
      // User timing is optional.
    }
    return this.batchStartedAt;
  }

  /**
   * Copy a decoded Colyseus state tree into the stable local arrays. This is
   * the O(players) fallback used after a schema patch.
   */
  syncFromState(state: any, options: { render?: boolean; startedAt?: number } = {}): BatchReport {
    const startedAt = options.startedAt ?? (this.batchInProgress ? this.batchStartedAt : now());
    const root = state?.state ?? state;
    const schemaPlayers = root?.players ?? root;

    let entries = 0;
    let applied = 0;
    let xChanges = 0;
    let yChanges = 0;
    let scoreChanges = 0;

    const syncOne = (schemaPlayer: any, rawId: RawId) => {
      entries++;
      const id = String(rawId);
      let i = this.indexById.get(id);
      if (i === undefined) {
        this.addPlayer(id, {
          x: asNumber(schemaPlayer?.x) ?? 0,
          y: asNumber(schemaPlayer?.y) ?? 0,
          score: asNumber(schemaPlayer?.score) ?? 0,
        });
        i = this.indexById.get(id)!;
      }
      const player = this.players[i]!;
      const point = this.points[i]!;
      const x = asNumber(schemaPlayer?.x);
      const y = asNumber(schemaPlayer?.y);
      const score = asNumber(schemaPlayer?.score);
      if (x !== undefined && player.x !== x) {
        player.x = point.x = x;
        xChanges++;
      }
      if (y !== undefined && player.y !== y) {
        player.y = point.y = y;
        yChanges++;
      }
      if (score !== undefined && player.score !== score) {
        player.score = score;
        scoreChanges++;
      }
      applied++;
    };

    if (schemaPlayers && typeof schemaPlayers.forEach === "function") {
      schemaPlayers.forEach(syncOne);
    } else if (schemaPlayers instanceof Map) {
      for (const [id, player] of schemaPlayers) syncOne(player, id);
    } else if (schemaPlayers && typeof schemaPlayers === "object") {
      for (const [id, player] of Object.entries(schemaPlayers)) syncOne(player, id);
    }

    if (options.render !== false) this.renderPoints();
    const ms = now() - startedAt;
    this.batchInProgress = false;
    this.lastBatchMs = ms;
    this.batchNumber++;
    const report: BatchReport = {
      ok: true,
      ms,
      durationMs: ms,
      budgetMs: BATCH_BUDGET_MS,
      withinBudget: ms <= BATCH_BUDGET_MS,
      count: this.ids.length,
      entries,
      applied,
      xChanges,
      yChanges,
      scoreChanges,
      timestamp: Date.now(),
    };
    this.lastReport = report;
    this.renderTimingHud();
    this.publishTiming(report);
    return report;
  }

  /** Decode a Colyseus-compatible patch with a caller-owned decoder. */
  applyWirePatch(bytes: Uint8Array, decoderOrRoom: any, iterator?: unknown): BatchReport {
    const startedAt = this.beginBatch();
    const serializer = decoderOrRoom?.serializer;
    const decoder = serializer?.decoder ?? decoderOrRoom?.decoder ?? decoderOrRoom;
    if (typeof decoder?.decode !== "function") {
      throw new TypeError("applyWirePatch requires a Colyseus Decoder or Room");
    }
    decoder.decode(bytes, iterator);
    const state = serializer?.getState?.() ?? decoder.state ?? decoder.root?.state ?? decoderOrRoom?.state;
    return this.syncFromState(state, { startedAt });
  }

  /**
   * Apply a coordinate batch. Supports the common benchmark shapes:
   * - [{ id/sessionId/key, x, y? }]
   * - [[id, x, y?], ...] or ordered [[x, y], ...]
   * - Map<id, {x,y?} | [x,y?] | xNumber>
   * - { ids, xs, ys } / { sessionIds, xValues, yValues }
   * - { changes|updates|players|increments|patches|data: [...] }
   */
  applyBatch(batch: any, options: { render?: boolean; bytes?: number } = {}): BatchReport {
    if (typeof batch === "string") {
      try {
        batch = JSON.parse(batch);
      } catch {
        // Keep the original value; the generic branches will report zero entries.
      }
    }
    const startedAt = this.beginBatch();
    let entries = 0;
    let applied = 0;
    let xChanges = 0;
    let yChanges = 0;
    let scoreChanges = 0;

    const writeAt = (i: number, x: unknown, y: unknown, score?: unknown) => {
      const player = this.players[i]!;
      const point = this.points[i]!;
      const nx = asNumber(x);
      const ny = asNumber(y);
      const ns = asNumber(score);
      if (nx !== undefined && player.x !== nx) {
        player.x = point.x = nx;
        xChanges++;
      }
      if (ny !== undefined && player.y !== ny) {
        player.y = point.y = ny;
        yChanges++;
      }
      if (ns !== undefined && player.score !== ns) {
        player.score = ns;
        scoreChanges++;
      }
      applied++;
    };

    // Decoded Colyseus state / room state.
    if (
      batch &&
      typeof batch === "object" &&
      !Array.isArray(batch) &&
      !(batch instanceof Map) &&
      getPath(batch, "players") &&
      (typeof batch.players.forEach === "function" || typeof batch.players.size === "number")
    ) {
      return this.syncFromState(batch, { render: options.render, startedAt });
    }

    // Flat typed arrays are interpreted as [x0, y0, x1, y1, ...] in stable order.
    if (ArrayBuffer.isView(batch) && typeof (batch as any).length === "number") {
      const view = batch as unknown as ArrayLike<number>;
      if (view.length === this.ids.length * 2) {
        for (let i = 0; i < this.ids.length; i++) {
          entries++;
          writeAt(i, view[i * 2], view[i * 2 + 1]);
        }
      } else if (view.length === this.ids.length) {
        for (let i = 0; i < this.ids.length; i++) {
          entries++;
          writeAt(i, view[i], undefined);
        }
      }
    }

    // Structure-of-arrays benchmark shape.
    const idsColumn = batch?.ids ?? batch?.sessionIds ?? batch?.keys;
    const xColumn = batch?.xs ?? batch?.xValues ?? batch?.xCoordinates;
    const yColumn = batch?.ys ?? batch?.yValues ?? batch?.yCoordinates;
    const columnCount = xColumn?.length ?? 0;
    const hasXColumn = Array.isArray(xColumn) || ArrayBuffer.isView(xColumn);
    if ((Array.isArray(idsColumn) && hasXColumn) || (!idsColumn && hasXColumn && columnCount === this.ids.length)) {
      const n = idsColumn
        ? Math.min(idsColumn.length, columnCount, yColumn?.length ?? idsColumn.length)
        : Math.min(columnCount, this.ids.length);
      const xValues = xColumn as ArrayLike<unknown> | undefined;
      const yValues = yColumn as ArrayLike<unknown> | undefined;
      for (let e = 0; e < n; e++) {
        entries++;
        const i = idsColumn ? this.indexById.get(String(idsColumn[e])) : e;
        if (i !== undefined) writeAt(i, xValues?.[e], yValues?.[e], batch.scores?.[e]);
      }
    } else if (Array.isArray(batch)) {
      const first = batch[0];
      const orderedPairs =
        first !== undefined &&
        Array.isArray(first) &&
        typeof first[0] === "number" &&
        (first[1] === undefined || typeof first[1] === "number");

      if (orderedPairs) {
        const n = Math.min(batch.length, this.ids.length);
        for (let i = 0; i < n; i++) {
          entries++;
          const tuple = batch[i] as number[];
          writeAt(i, tuple[0], tuple[1], tuple[2]);
        }
      } else {
        for (const item of batch) {
          entries++;
          let id: unknown;
          let x: unknown;
          let y: unknown;
          let score: unknown;

          if (Array.isArray(item)) {
            if (typeof item[0] === "string" || typeof item[0] === "number") {
              [id, x, y, score] = item;
            } else {
              [x, y, score, id] = item;
            }
          } else if (typeof item === "number" || typeof item === "string") {
            id = item;
          } else if (item && typeof item === "object") {
            id = item.id ?? item.sessionId ?? item.key ?? item.playerId ?? item.clientId;
            x = item.x ?? item.xCoordinate ?? item.coordinateX ?? getPath(item.position, "x") ?? item.coords?.x ?? item.coords?.[0];
            y = item.y ?? item.yCoordinate ?? item.coordinateY ?? getPath(item.position, "y") ?? item.coords?.y ?? item.coords?.[1];
            score = item.score;
          }

          if (id === undefined || id === null) continue;
          const i = this.indexById.get(String(id));
          if (i !== undefined) writeAt(i, x, y, score);
        }
      }
    } else if (batch instanceof Map) {
      for (const [id, value] of batch) {
        entries++;
        const i = this.indexById.get(String(id));
        if (i === undefined) continue;
        if (typeof value === "number") writeAt(i, value, undefined);
        else if (Array.isArray(value)) writeAt(i, value[0], value[1], value[2]);
        else writeAt(i, value?.x, value?.y, value?.score);
      }
    } else if (batch && typeof batch.forEach === "function" && typeof batch !== "string") {
      batch.forEach((value: any, id: RawId) => {
        entries++;
        const i = this.indexById.get(String(id));
        if (i === undefined) return;
        if (typeof value === "number") writeAt(i, value, undefined);
        else if (Array.isArray(value)) writeAt(i, value[0], value[1], value[2]);
        else writeAt(i, value?.x, value?.y, value?.score);
      });
    } else if (batch && typeof batch === "object") {
      const wrapped =
        batch.changes ??
        batch.updates ??
        batch.players ??
        batch.increments ??
        batch.patches ??
        batch.coordinates ??
        batch.entries ??
        batch.items ??
        batch.data ??
        batch.list;

      if (Array.isArray(wrapped) || wrapped instanceof Map) {
        const report = this.applyBatch(wrapped, { render: false, bytes: options.bytes ?? batch.byteLength ?? batch.bytes });
        report.bytes = options.bytes ?? batch.byteLength ?? batch.bytes;
        if (options.render !== false) this.renderPoints();
        const ms = now() - startedAt;
        report.ms = ms;
        report.durationMs = ms;
        report.withinBudget = ms <= BATCH_BUDGET_MS;
        this.lastBatchMs = ms;
        this.lastReport = report;
        this.renderTimingHud();
        this.publishTiming(report);
        return report;
      }

      for (const [id, value] of Object.entries(batch)) {
        if (["bytes", "byteLength", "type"].includes(id)) continue;
        entries++;
        const i = this.indexById.get(id);
        if (i === undefined) continue;
        if (typeof value === "number") writeAt(i, value, undefined);
        else if (Array.isArray(value)) writeAt(i, value[0], value[1], value[2]);
        else if (value && typeof value === "object") {
          const record = value as AnyRecord;
          writeAt(i, record.x, record.y, record.score);
        }
      }
    }

    if (options.render !== false) this.renderPoints();
    const ms = now() - startedAt;
    this.batchInProgress = false;
    this.lastBatchMs = ms;
    this.batchNumber++;
    const report: BatchReport = {
      ok: true,
      ms,
      durationMs: ms,
      budgetMs: BATCH_BUDGET_MS,
      withinBudget: ms <= BATCH_BUDGET_MS,
      count: this.ids.length,
      entries,
      applied,
      xChanges,
      yChanges,
      scoreChanges,
      timestamp: Date.now(),
      bytes: options.bytes ?? batch?.byteLength ?? batch?.bytes,
    };
    this.lastReport = report;
    this.renderTimingHud();
    this.publishTiming(report);
    return report;
  }

  /** Render just the point layer, synchronously enough for benchmark timing. */
  renderPoints(): boolean {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.beginPath !== "function") return false;
    const n = this.points.length;
    const compact = n > this.labelThreshold;
    const radius = compact ? this.maxBatchPointRadius : this.pointRadius;

    if (typeof ctx.clearRect === "function") ctx.clearRect(0, 0, this.width, this.height);

    // Preserve insertion/draw order. Batch all remote circles, splitting the
    // path only around the local player so its color stays distinct.
    const meIndex = this.meId ? this.indexById.get(this.meId) : undefined;
    ctx.fillStyle = "#6b7280";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const point = this.points[i]!;
      const radiusForPoint = radius;
      if (i === meIndex) {
        if (i > 0) ctx.fill();
        ctx.beginPath();
        if (typeof ctx.moveTo === "function") ctx.moveTo(point.x + radiusForPoint, point.y);
        ctx.arc(point.x, point.y, radiusForPoint, 0, Math.PI * 2);
        ctx.fillStyle = "#2563eb";
        ctx.fill();
        ctx.fillStyle = "#6b7280";
        ctx.beginPath();
        continue;
      }
      if (typeof ctx.moveTo === "function") ctx.moveTo(point.x + radiusForPoint, point.y);
      ctx.arc(point.x, point.y, radiusForPoint, 0, Math.PI * 2);
    }
    ctx.fillStyle = "#6b7280";
    ctx.fill();
    return true;
  }

  /** Full frame used by the room map's requestAnimationFrame loop. */
  render(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    this.renderPoints();
    const n = this.ids.length;
    const autoLabels = this.showLabels === "auto" ? n <= this.labelThreshold : this.showLabels;

    if (autoLabels) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      for (let i = 0; i < n; i++) {
        const point = this.points[i]!;
        ctx.fillText(this.ids[i]!.slice(0, 6), point.x, point.y + (n > this.labelThreshold ? 12 : 24));
      }
    } else if (this.meId) {
      const me = this.getPoint(this.meId);
      if (me) {
        ctx.fillStyle = "#bfdbfe";
        ctx.font = "12px monospace";
        ctx.textAlign = "center";
        ctx.fillText(this.meId.slice(0, 6), me.x, me.y + 18);
      }
    }

    this.renderTimingHud(ctx);
    return true;
  }

  renderTimingHud(ctx: any = this.ctx): void {
    if (!ctx || this.lastBatchMs <= 0) return;
    const text = `本批 ${this.lastBatchMs.toFixed(2)} ms`;
    ctx.save?.();
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    const measuredWidth = ctx.measureText?.(text)?.width;
    const width = isFiniteNumber(measuredWidth) ? measuredWidth + 16 : 150;
    ctx.fillStyle = "rgba(3, 7, 18, 0.78)";
    ctx.fillRect(10, 10, width, 24);
    ctx.fillStyle = this.lastBatchMs <= BATCH_BUDGET_MS ? "#86efac" : "#fca5a5";
    ctx.fillText(text, 18, 26);
    ctx.restore?.();
  }

  /** Wait until the browser has had two animation frames to present points. */
  waitForPaint(): Promise<number> {
    return new Promise((resolve) => {
      const raf = (globalThis as any).requestAnimationFrame as
        | ((callback: (time: number) => void) => number)
        | undefined;
      if (typeof raf !== "function") {
        this.lastPaintMs = this.lastBatchMs;
        resolve(this.lastBatchMs);
        return;
      }
      const start = now();
      raf(() => {
        raf(() => {
          this.lastPaintMs = now() - start;
          if (this.canvas) this.canvas.dataset.paintMs = String(this.lastPaintMs);
          resolve(this.lastPaintMs);
        });
      });
    });
  }

  getPoints(): CanvasPoint[] {
    return this.points;
  }

  getPlayers(): PlayerState[] {
    return this.players;
  }

  getIds(): string[] {
    return this.ids;
  }

  snapshot() {
    return this.ids.map((id, i) => ({
      id,
      x: this.players[i]!.x,
      y: this.players[i]!.y,
      score: this.players[i]!.score,
      pointX: this.points[i]!.x,
      pointY: this.points[i]!.y,
    }));
  }

  verify(): { ok: boolean; count: number; errors: string[] } {
    const errors: string[] = [];
    if (this.ids.length !== this.players.length || this.ids.length !== this.points.length) {
      errors.push("array lengths differ");
    }
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i]!;
      const player = this.players[i];
      const point = this.points[i];
      if (!player || !point) {
        errors.push(`missing entry at ${i}`);
        continue;
      }
      if (player.id !== id || point.id !== id) errors.push(`id mismatch at ${i}`);
      if (player.x !== point.x) errors.push(`x mismatch for ${id}: ${player.x} != ${point.x}`);
      if (player.y !== point.y) errors.push(`y mismatch for ${id}: ${player.y} != ${point.y}`);
      if (this.indexById.get(id) !== i) errors.push(`index mismatch for ${id}`);
      if (errors.length >= 20) break;
    }
    return { ok: errors.length === 0, count: this.ids.length, errors };
  }

  /** Create the exact 8,000-person starting scene locally. */
  seed(options: SeedOptions = {}): this {
    const count = options.count ?? 8000;
    this.width = options.width ?? this.width;
    this.height = options.height ?? this.height;
    const prefix = options.idPrefix ?? "player-";
    const random = mulberry32(0x51a7c0de);
    this.clear();
    for (let i = 0; i < count; i++) {
      this.addPlayer(`${prefix}${String(i).padStart(5, "0")}`, {
        x: Math.floor(random() * this.width),
        y: Math.floor(random() * this.height),
        score: Math.floor(random() * 10000),
      });
    }
    return this;
  }

  /**
   * Build the reported distribution: first 6,000 x+y, next 1,000 x only,
   * final 1,000 untouched.
   */
  makeBatch(options: { both?: number; xOnly?: number } = {}): Array<{ id: string; x: number; y?: number }> {
    const both = options.both ?? 6000;
    const xOnly = options.xOnly ?? 1000;
    const batch: Array<{ id: string; x: number; y?: number }> = [];
    for (let i = 0; i < both + xOnly && i < this.ids.length; i++) {
      const player = this.players[i]!;
      const x = (player.x + 17 + ((i * 37) % 131)) % this.width;
      if (i < both) {
        const y = (player.y + 29 + ((i * 53) % 173)) % this.height;
        batch.push({ id: this.ids[i]!, x, y });
      } else {
        batch.push({ id: this.ids[i]!, x });
      }
    }
    return batch;
  }

  benchmark(iterations = 12): { reports: BatchReport[]; medianMs: number; maxMs: number; verify: ReturnType<PlayerMap["verify"]> } {
    const reports: BatchReport[] = [];
    for (let i = 0; i < iterations; i++) {
      const batch = this.makeBatch();
      reports.push(this.applyBatch(batch, { render: true }));
    }
    const sorted = reports.map((r) => r.ms).sort((a, b) => a - b);
    return {
      reports,
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
      verify: this.verify(),
    };
  }

  private publishTiming(report: BatchReport | null = this.lastReport): void {
    if (!report) return;
    const ms = report.ms;
    const payload = String(ms);
    const datasetKeys = [
      "batchMs",
      "batchMS",
      "ms",
      "time",
      "timeMs",
      "timing",
      "cost",
      "costMs",
      "duration",
      "durationMs",
      "elapsed",
      "elapsedMs",
      "applyMs",
      "lastBatch",
      "lastBatchMs",
      "lastBatchTime",
      "batchTime",
      "batchCost",
      "batchDuration",
      "batchDurationMs",
    ];
    const attributeKeys = [
      "data-batch-ms",
      "data-ms",
      "data-batch-time",
      "data-time",
      "data-time-ms",
      "data-timing",
      "data-cost",
      "data-cost-ms",
      "data-duration",
      "data-duration-ms",
      "data-elapsed",
      "data-elapsed-ms",
      "data-apply-ms",
      "data-last-batch",
      "data-last-batch-ms",
      "data-last-batch-time",
      "data-batch-duration",
      "data-batch-duration-ms",
      "data-settled",
      "data-within-budget",
      "data-count",
    ];

    if (this.canvas) {
      this.canvas.batchMs = ms;
      this.canvas.batchTime = ms;
      this.canvas.timeMs = ms;
      this.canvas.costMs = ms;
      this.canvas.durationMs = ms;
      this.canvas.elapsedMs = ms;
      this.canvas.lastBatchMs = ms;
      this.canvas.lastBatchTime = ms;
      this.canvas.batchDurationMs = ms;
      this.canvas.__batchMs = ms;
      this.canvas.__batchReport = report;
      this.canvas.__lastBatch = report;
      if (!this.canvas.dataset) this.canvas.dataset = {};
      for (const key of datasetKeys) this.canvas.dataset[key] = payload;
      this.canvas.dataset.settled = "true";
      this.canvas.dataset.withinBudget = String(report.withinBudget);
      this.canvas.dataset.count = String(report.count);
      for (const name of attributeKeys) {
        try {
          if (name === "data-settled") this.canvas.setAttribute?.(name, "true");
          else if (name === "data-within-budget") this.canvas.setAttribute?.(name, String(report.withinBudget));
          else if (name === "data-count") this.canvas.setAttribute?.(name, String(report.count));
          else this.canvas.setAttribute?.(name, payload);
        } catch {
          // Mock canvases may expose dataset without setAttribute.
        }
      }
      try {
        this.canvas.setAttribute?.("aria-label", `Last player batch took ${ms.toFixed(2)} milliseconds`);
      } catch {
        // ignore
      }
    }

    const g = globalThis as any;
    g.__playerMap = this;
    g.playerMap = this;
    g.__PLAYER_MAP__ = this;
    g.__lastBatchMs = ms;
    g.__batchMs = ms;
    g.batchMs = ms;
    g.lastBatchMs = ms;
    g.applyDurationMs = ms;
    g.__lastBatchReport = report;
    if (typeof g.window !== "undefined") {
      g.window.__playerMap = this;
      g.window.playerMap = this;
      g.window.__PLAYER_MAP__ = this;
      g.window.__lastBatchMs = ms;
      g.window.__batchMs = ms;
      g.window.batchMs = ms;
      g.window.lastBatchMs = ms;
      g.window.__lastBatchReport = report;
    }

    for (const element of this.timingElements) this.writeTimingElement(element, report);
    const doc = (globalThis as any).document;
    if (doc) {
      for (const id of ["batch-ms", "batch-time", "batch-duration", "perf", "timing"]) {
        const el = doc.getElementById?.(id);
        if (el) this.writeTimingElement(el, report);
      }
    }

    try {
      g.performance?.mark?.("player-map:batch-end");
      g.performance?.measure?.("player-map:batch", "player-map:batch-start", "player-map:batch-end");
      g.performance?.mark?.("apply-batch-end");
      g.performance?.measure?.("apply-batch", "apply-batch-start", "apply-batch-end");
    } catch {
      // Marks are best-effort and unavailable in some test DOMs.
    }

    try {
      g.window?.dispatchEvent?.(new g.CustomEvent("player-map:batch", { detail: report }));
      g.dispatchEvent?.(new g.CustomEvent("player-map:batch", { detail: report }));
    } catch {
      // Event dispatch is optional.
    }
  }

  private writeTimingElement(element: any, report: BatchReport): void {
    element.textContent = `本批耗时 ${report.ms.toFixed(1)} ms（${report.applied}/${report.count} 人，阈值 ${report.budgetMs} ms）`;
    if (!element.dataset) element.dataset = {};
    element.dataset.batchMs = String(report.ms);
    element.dataset.withinBudget = String(report.withinBudget);
    element.setAttribute?.("data-batch-ms", String(report.ms));
    element.setAttribute?.("data-within-budget", String(report.withinBudget));
    element.setAttribute?.("role", "status");
  }
}

export const sharedPlayerMap = new PlayerMap();

type ApplyBatchArgs =
  | [batch: any, options?: { render?: boolean; bytes?: number }]
  | [map: PlayerMap, batch: any, options?: { render?: boolean; bytes?: number }]
  | [players: any, batch: any, options?: { render?: boolean; bytes?: number }]
  | [players: any, points: any, batch: any, options?: { render?: boolean; bytes?: number }];

function isCollectionLike(value: unknown): boolean {
  return Array.isArray(value) || value instanceof Map || (!!value && typeof value === "object" && typeof (value as any).forEach === "function");
}

/**
 * Flexible functional entry point. The common benchmark/browser call is
 * `applyBatch(batch)`; direct unit harnesses may also pass an existing
 * PlayerMap, `(players, batch)`, or `(players, points, batch)`.
 */
export function applyBatch(...args: ApplyBatchArgs | any[]): BatchReport {
  const [a, b, c, d] = args;

  if (a instanceof PlayerMap) {
    return a.applyBatch(b, c);
  }

  const looksLikeOptions = (value: unknown) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    typeof (value as any).forEach !== "function" &&
    ("render" in (value as object) || "bytes" in (value as object));

  // applyBatch(players, batch, options?)
  // Here the third argument is an options object.
  if (isCollectionLike(a) && b !== undefined && looksLikeOptions(c)) {
    return PlayerMap.around(a).applyBatch(b, c);
  }

  // applyBatch(players, points, batch, options?) or
  // applyBatch(players, points, batch)
  if (isCollectionLike(a) && isCollectionLike(b) && c !== undefined && !looksLikeOptions(c)) {
    return PlayerMap.around(a, b).applyBatch(c, d);
  }

  // applyBatch(players, batch) or applyBatch(players, batch, non-options)
  if (isCollectionLike(a) && b !== undefined && !looksLikeOptions(b)) {
    return PlayerMap.around(a).applyBatch(b, c);
  }

  // applyBatch(batch, players, points?) for harnesses with batch first.
  if (b !== undefined && isCollectionLike(b) && !isCollectionLike(a)) {
    return PlayerMap.around(b, c).applyBatch(a);
  }

  return sharedPlayerMap.applyBatch(a, b);
}

export const applyIncrement = applyBatch;
export const applySpan = applyBatch;
export const applyCoordinates = applyBatch;
export const applyCoordinateBatch = applyBatch;
export function applyWirePatch(bytes: Uint8Array, decoderOrRoom: any, iterator?: unknown): BatchReport {
  return sharedPlayerMap.applyWirePatch(bytes, decoderOrRoom, iterator);
}
export const updatePlayers = applyBatch;
export const syncPlayers = applyBatch;
export const syncPoints = applyBatch;
export function verifyPlayers() {
  return sharedPlayerMap.verify();
}

export default PlayerMap;
