"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Check,
  CloudOff,
  LogOut,
  Play,
  Square,
  Wifi,
  X
} from "lucide-react";
import { clearSession, loadSession } from "@/lib/auth/session";
import { t } from "@/lib/i18n";
import { offlineDb, type OutboxItem } from "@/lib/offline/db";
import {
  cacheStations,
  cacheTeams,
  dismissConflict,
  enqueueWrite,
  flushOutbox,
  getConflictItems
} from "@/lib/offline/outbox";
import { getRouteOrder } from "@/lib/reset";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  computeElapsedMs,
  formatClockSeconds,
  formatDurationMs,
  serverAdjustedNow,
  syncServerClock
} from "@/lib/timer/clock";
import { WakeLockController } from "@/lib/timer/wakeLock";
import type {
  AttemptRow,
  EventSettingsRow,
  RoleSession,
  StationConfig,
  TeamPublic
} from "@/lib/types/domain";
import { QrScanner } from "@/components/qr/QrScanner";
import { ResetPanel, type InboundTeamInfo } from "@/components/host/ResetPanel";

type HostPhase = "scan" | "ready" | "running" | "result" | "bonus" | "review" | "reset";

const ACTIVE_RUN_META_KEY = "active_host_run";

interface ActiveHostRunSnapshot {
  station_id: number;
  session_id: string;
  phase: Exclude<HostPhase, "scan" | "reset">;
  selectedTeam: TeamPublic;
  attemptId: string;
  arrivedAtIso: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  elapsedMs: number;
  completed: boolean;
  progress: number | null;
  countValue: number;
  counters: Record<string, number>;
  bonusCorrect: boolean | null;
  stampedVariant: string | null;
  practiceMode: boolean;
  wrongStationWarn: boolean;
}

function playBeep(freq = 880, durationMs = 140) {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      void ctx.close();
    }, durationMs);
  } catch {
    // Audio optional
  }
}

function vibrate(pattern: number | number[]) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    // Vibration unsupported on iOS
  }
}

export function HostApp() {
  const router = useRouter();
  const [session, setSession] = useState<RoleSession | null>(null);
  const [station, setStation] = useState<StationConfig | null>(null);
  const [settings, setSettings] = useState<EventSettingsRow | null>(null);
  const [teams, setTeams] = useState<TeamPublic[]>([]);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [conflicts, setConflicts] = useState<OutboxItem[]>([]);
  const [practiceMode, setPracticeMode] = useState(false);

  // Flow & QR scanner state
  const [phase, setPhase] = useState<HostPhase>("scan");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [teamInput, setTeamInput] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<TeamPublic | null>(null);
  const [wrongStationWarn, setWrongStationWarn] = useState(false);

  // Active attempt state
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [arrivedAtIso, setArrivedAtIso] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [endedAtMs, setEndedAtMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [countValue, setCountValue] = useState(0);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [bonusCorrect, setBonusCorrect] = useState<boolean | null>(null);
  const [stampedVariant, setStampedVariant] = useState<string | null>(null);

  // Widget overlays / hover state (timestamp-derived)
  const [holdEndsAtMs, setHoldEndsAtMs] = useState<number | null>(null);
  const [holdRemainingMs, setHoldRemainingMs] = useState(0);
  const [hoverStartedAtMs, setHoverStartedAtMs] = useState<number | null>(null);
  const [hoverRemainingMs, setHoverRemainingMs] = useState(0);
  const [capFlash, setCapFlash] = useState(false);

  // Reset Panel & Undo state
  const [lastSubmittedId, setLastSubmittedId] = useState<string | null>(null);
  const lastSubmittedIdRef = useRef<string | null>(null);
  const [undoDeadlineMs, setUndoDeadlineMs] = useState<number | null>(null);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const [lastAttemptSynced, setLastAttemptSynced] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetStartedAtMs, setResetStartedAtMs] = useState<number | null>(null);
  const [resetItemsDone, setResetItemsDone] = useState(0);
  const [inboundTeam, setInboundTeam] = useState<InboundTeamInfo | null>(null);

  const capFiredRef = useRef(false);
  const wakeLockRef = useRef<WakeLockController | null>(null);

  useEffect(() => {
    lastSubmittedIdRef.current = lastSubmittedId;
  }, [lastSubmittedId]);

  const refreshSyncCounters = useCallback(async (s: RoleSession) => {
    const res = await flushOutbox(s);
    setPendingCount(res.pendingCount);
    setConflicts(await getConflictItems());
    if (lastSubmittedIdRef.current) {
      const ob = await offlineDb.outbox.get(lastSubmittedIdRef.current);
      if (ob?.status === "synced") setLastAttemptSynced(true);
    }
  }, []);

  // Persist active run snapshot in Dexie for crash / accidental reload recovery
  useEffect(() => {
    if (!session || !station) return;
    if (
      (phase === "ready" ||
        phase === "running" ||
        phase === "result" ||
        phase === "bonus" ||
        phase === "review") &&
      selectedTeam &&
      attemptId
    ) {
      const snap: ActiveHostRunSnapshot = {
        station_id: station.id,
        session_id: session.session_id,
        phase,
        selectedTeam,
        attemptId,
        arrivedAtIso: arrivedAtIso ?? new Date(serverAdjustedNow(clockOffsetMs)).toISOString(),
        startedAtMs,
        endedAtMs,
        elapsedMs,
        completed,
        progress,
        countValue,
        counters,
        bonusCorrect,
        stampedVariant,
        practiceMode,
        wrongStationWarn
      };
      void offlineDb.meta.put({ key: ACTIVE_RUN_META_KEY, value: snap });
    } else if (phase === "scan" || phase === "reset") {
      void offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
    }
  }, [
    session,
    station,
    phase,
    selectedTeam,
    attemptId,
    arrivedAtIso,
    startedAtMs,
    endedAtMs,
    elapsedMs,
    completed,
    progress,
    countValue,
    counters,
    bonusCorrect,
    stampedVariant,
    practiceMode,
    wrongStationWarn,
    clockOffsetMs
  ]);

  // Acquire Wake Lock during running phase
  useEffect(() => {
    if (!wakeLockRef.current) {
      wakeLockRef.current = new WakeLockController();
    }
    if (phase === "running") {
      void wakeLockRef.current.acquire();
    } else {
      void wakeLockRef.current.release();
    }
    return () => {
      void wakeLockRef.current?.release();
    };
  }, [phase]);

  // Load session, restore any interrupted attempt, & bootstrap caches (once on mount)
  useEffect(() => {
    const s = loadSession();
    if (!s || !s.station_id) {
      router.replace("/login");
      return;
    }
    setSession(s);
    setOnline(typeof navigator !== "undefined" ? navigator.onLine : true);
    void syncServerClock().then((off) => setClockOffsetMs(off));

    const supabase = getSupabaseClient(s);

    async function hydrate() {
      const cachedSt = await offlineDb.stations.get(s!.station_id!);
      if (cachedSt) setStation(cachedSt);
      const cachedTeams = await offlineDb.teams.toArray();
      if (cachedTeams.length > 0) setTeams(cachedTeams);

      const savedRun = await offlineDb.meta.get(ACTIVE_RUN_META_KEY);
      if (savedRun?.value) {
        const snap = savedRun.value as ActiveHostRunSnapshot;
        if (snap.station_id === s!.station_id && snap.session_id === s!.session_id) {
          setSelectedTeam(snap.selectedTeam);
          setAttemptId(snap.attemptId);
          setArrivedAtIso(snap.arrivedAtIso);
          setStartedAtMs(snap.startedAtMs);
          setEndedAtMs(snap.endedAtMs);
          setElapsedMs(snap.elapsedMs);
          setCompleted(snap.completed);
          setProgress(snap.progress);
          setCountValue(snap.countValue);
          setCounters(snap.counters);
          setBonusCorrect(snap.bonusCorrect);
          setStampedVariant(snap.stampedVariant);
          setPracticeMode(snap.practiceMode);
          setWrongStationWarn(snap.wrongStationWarn);
          setPhase(snap.phase);
        } else {
          await offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
        }
      }

      const [{ data: stData }, { data: tmData }, { data: setData }] = await Promise.all([
        supabase.from("stations").select("config").eq("id", s!.station_id!).maybeSingle(),
        supabase.from("teams_public").select("id,number,church,team_name,token,route,withdrawn"),
        supabase.from("event_settings").select("*").eq("id", 1).maybeSingle()
      ]);

      if (stData?.config) {
        const cfg = stData.config as StationConfig;
        setStation(cfg);
        await cacheStations([cfg]);
      }
      if (tmData) {
        const list = tmData as TeamPublic[];
        setTeams(list);
        await cacheTeams(list);
      }
      if (setData) {
        const es = setData as EventSettingsRow;
        setSettings(es);
        if (es.event_state === "live") setPracticeMode(false);
      }

      await refreshSyncCounters(s!);
    }

    void hydrate();

    const onOnline = () => {
      setOnline(true);
      void refreshSyncCounters(s);
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const pollId = window.setInterval(async () => {
      if (!navigator.onLine) return;
      const [{ data: sessRow }, { data: esRow }, { data: inbRows }] = await Promise.all([
        supabase
          .from("role_sessions")
          .select("revoked_at")
          .eq("session_id", s.session_id)
          .maybeSingle(),
        supabase.from("event_settings").select("*").eq("id", 1).maybeSingle(),
        supabase.rpc("get_station_inbound")
      ]);
      if (sessRow?.revoked_at) {
        clearSession();
        router.replace("/login");
        return;
      }
      if (esRow) {
        const es = esRow as EventSettingsRow;
        setSettings(es);
        if (es.event_state === "live") setPracticeMode(false);
      }
      if (Array.isArray(inbRows) && inbRows.length > 0) {
        setInboundTeam(inbRows[0] as InboundTeamInfo);
      } else {
        setInboundTeam(null);
      }
      await refreshSyncCounters(s);
    }, 5000);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(pollId);
    };
  }, [router, refreshSyncCounters]);

  const capMs = (station?.cap_s ?? 120) * 1000;
  const hoverHoldMs = (station?.hover?.hold_s ?? 5) * 1000;

  const finishRun = useCallback(
    (didComplete: boolean, finalTimeMs: number, countOverride?: number) => {
      const nowAdj = serverAdjustedNow(clockOffsetMs);
      setEndedAtMs(nowAdj);
      setElapsedMs(finalTimeMs);
      setCompleted(didComplete);
      setHoldEndsAtMs(null);
      setHoldRemainingMs(0);
      setHoverStartedAtMs(null);
      setHoverRemainingMs(0);

      if (station?.widget === "counter_countdown") {
        setProgress(countOverride ?? countValue);
        setPhase(station.bonus ? "bonus" : "review");
        return;
      }

      if (didComplete || station?.widget === "hover_hold") {
        setProgress(null);
        setPhase(station?.bonus ? "bonus" : "review");
      } else {
        if (station?.progress?.kind === "stepper") {
          setProgress(station.progress.min);
        } else {
          setProgress(null);
        }
        setPhase("result");
      }
    },
    [clockOffsetMs, countValue, station]
  );

  // High-frequency timestamp tick while running
  useEffect(() => {
    if (phase !== "running" || startedAtMs === null || !station) return;

    const tick = () => {
      const nowAdj = serverAdjustedNow(clockOffsetMs);
      const nextElapsed = computeElapsedMs(startedAtMs, nowAdj, capMs);
      setElapsedMs(nextElapsed);

      if (holdEndsAtMs !== null) {
        const rem = Math.max(0, holdEndsAtMs - nowAdj);
        setHoldRemainingMs(rem);
        if (rem <= 0) {
          setHoldEndsAtMs(null);
        }
      }

      if (nextElapsed >= capMs && !capFiredRef.current) {
        capFiredRef.current = true;
        setCapFlash(true);
        playBeep(440, 350);
        vibrate([200, 100, 200]);
        setTimeout(() => setCapFlash(false), 600);
        if (station.widget === "counter_countdown") {
          finishRun(true, capMs);
        } else {
          finishRun(false, capMs);
        }
        return;
      }

      if (station.widget === "hover_hold" && hoverStartedAtMs !== null) {
        const hoverElapsed = nowAdj - hoverStartedAtMs;
        const rem = Math.max(0, hoverHoldMs - hoverElapsed);
        setHoverRemainingMs(rem);
        if (rem <= 0 && !capFiredRef.current) {
          capFiredRef.current = true;
          playBeep(1046, 220);
          vibrate(150);
          finishRun(true, nextElapsed);
        }
      }
    };

    tick();
    const id = window.setInterval(tick, 100);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [
    phase,
    startedAtMs,
    clockOffsetMs,
    capMs,
    station,
    holdEndsAtMs,
    hoverStartedAtMs,
    hoverHoldMs,
    finishRun
  ]);

  // 60-second Undo countdown
  useEffect(() => {
    if (phase !== "reset" || undoDeadlineMs === null) return;
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((undoDeadlineMs - Date.now()) / 1000));
      setUndoSecondsLeft(left);
    }, 500);
    return () => window.clearInterval(id);
  }, [phase, undoDeadlineMs]);

  const recordResetLog = useCallback(
    async (skipped: boolean, itemsDone: number) => {
      if (!session || !station || !resetId || !resetStartedAtMs) return;
      const nowAdj = serverAdjustedNow(clockOffsetMs);
      await enqueueWrite("station_resets", resetId, {
        id: resetId,
        station_id: station.id,
        after_attempt_id: lastSubmittedId,
        started_at: new Date(resetStartedAtMs).toISOString(),
        done_at: skipped ? null : new Date(nowAdj).toISOString(),
        items_done: itemsDone,
        skipped,
        session_id: session.session_id
      });
      setResetId(null);
      setResetStartedAtMs(null);
      setResetItemsDone(0);
      await refreshSyncCounters(session);
    },
    [session, station, resetId, resetStartedAtMs, clockOffsetMs, lastSubmittedId, refreshSyncCounters]
  );

  const resolveAndSelectTeam = useCallback(
    async (query: { token?: string; number?: number }) => {
      if (!session || !station) return;
      setLookupError(null);

      let found: TeamPublic | undefined;
      if (query.token) {
        const cleanTok = query.token.trim().toUpperCase();
        found = teams.find((tm) => tm.token.toUpperCase() === cleanTok && !tm.withdrawn);
        if (!found) {
          const fromDb = await offlineDb.teams.where("token").equals(cleanTok).first();
          if (fromDb && !fromDb.withdrawn) found = fromDb;
        }
      } else if (query.number !== undefined) {
        found = teams.find((tm) => tm.number === query.number && !tm.withdrawn);
      }

      if (!found) {
        setLookupError(t("host.unknown_team"));
        return;
      }

      if (phase === "reset" && resetId) {
        await recordResetLog(true, resetItemsDone);
      }

      const isPractice = settings?.event_state === "live" ? false : practiceMode;

      if (!isPractice) {
        const localExisting = await offlineDb.local_attempts
          .where("[team_id+station_id]")
          .equals([found.id, station.id])
          .filter((a) => !a.practice && !a.voided)
          .first();

        let remoteExisting = false;
        if (navigator.onLine) {
          const supabase = getSupabaseClient(session);
          const { data } = await supabase
            .from("attempts")
            .select("id")
            .eq("team_id", found.id)
            .eq("station_id", station.id)
            .eq("practice", false)
            .eq("voided", false)
            .limit(1);
          remoteExisting = (data?.length ?? 0) > 0;
        }

        if (localExisting || remoteExisting) {
          setLookupError(t("host.already_played"));
          return;
        }
      }

      const order = getRouteOrder(found.route);
      const isExpectedInbound = inboundTeam?.team_id === found.id;
      const isFirstOnRoute = order[0] === station.id;
      const offRoute = !isExpectedInbound && !isFirstOnRoute && inboundTeam !== null;
      setWrongStationWarn(offRoute);

      const newId = crypto.randomUUID();
      const nowIso = new Date(serverAdjustedNow(clockOffsetMs)).toISOString();
      const variant = station.id === 7 ? (settings?.current_variant ?? "W1") : null;

      setCameraOpen(false);
      setSelectedTeam(found);
      setAttemptId(newId);
      setArrivedAtIso(nowIso);
      setStartedAtMs(null);
      setEndedAtMs(null);
      setStampedVariant(variant);
      setCounters({});
      setCountValue(0);
      setProgress(null);
      setBonusCorrect(null);
      setElapsedMs(0);
      setCompleted(false);
      setPhase("ready");

      const arrivedRow: AttemptRow = {
        id: newId,
        team_id: found.id,
        station_id: station.id,
        state: "arrived",
        arrived_at: nowIso,
        started_at: null,
        ended_at: null,
        scored_at: null,
        completed: null,
        time_ms: null,
        progress: null,
        counters: {},
        bonus_correct: null,
        variant,
        practice: isPractice,
        voided: false,
        version: 1,
        session_id: session.session_id
      };
      await enqueueWrite("attempts", newId, arrivedRow as unknown as Record<string, unknown>);
      await refreshSyncCounters(session);
    },
    [
      session,
      station,
      teams,
      phase,
      resetId,
      recordResetLog,
      resetItemsDone,
      practiceMode,
      inboundTeam,
      clockOffsetMs,
      settings,
      refreshSyncCounters
    ]
  );

  function handleLookupNumber() {
    const num = Number.parseInt(teamInput.trim(), 10);
    if (Number.isNaN(num)) {
      setLookupError(t("host.unknown_team"));
      return;
    }
    void resolveAndSelectTeam({ number: num });
  }

  async function handleStart() {
    if (!session || !station || !selectedTeam || !attemptId) return;
    playBeep(880, 120);
    vibrate(60);
    capFiredRef.current = false;
    const nowAdj = serverAdjustedNow(clockOffsetMs);
    const startedIso = new Date(nowAdj).toISOString();
    setStartedAtMs(nowAdj);
    setElapsedMs(0);
    setHoverStartedAtMs(null);
    setHoldEndsAtMs(null);
    setHoldRemainingMs(0);
    setPhase("running");

    const isPractice = settings?.event_state === "live" ? false : practiceMode;
    const startedRow: AttemptRow = {
      id: attemptId,
      team_id: selectedTeam.id,
      station_id: station.id,
      state: "started",
      arrived_at: arrivedAtIso ?? startedIso,
      started_at: startedIso,
      ended_at: null,
      scored_at: null,
      completed: null,
      time_ms: null,
      progress: null,
      counters: {},
      bonus_correct: null,
      variant: stampedVariant,
      practice: isPractice,
      voided: false,
      version: 1,
      session_id: session.session_id
    };
    await enqueueWrite("attempts", attemptId, startedRow as unknown as Record<string, unknown>);
    await refreshSyncCounters(session);
  }

  async function handleCancelBeforeStart() {
    if (session && attemptId) {
      const ob = await offlineDb.outbox.get(attemptId);
      if (ob && ob.status !== "synced") {
        await offlineDb.outbox.delete(attemptId);
        await offlineDb.local_attempts.delete(attemptId);
      } else if (navigator.onLine) {
        const supabase = getSupabaseClient(session);
        await supabase.rpc("host_cancel_before_start", { p_attempt_id: attemptId });
        await offlineDb.local_attempts.update(attemptId, { voided: true });
      }
      await offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
      const pending = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
      setPendingCount(pending);
    }

    setSelectedTeam(null);
    setAttemptId(null);
    setArrivedAtIso(null);
    setTeamInput("");
    setPhase("scan");
  }

  async function handleSubmitAttempt() {
    if (!session || !station || !selectedTeam || !attemptId) return;
    const nowAdj = serverAdjustedNow(clockOffsetMs);
    const finalEndMs = endedAtMs ?? nowAdj;
    const payload: AttemptRow = {
      id: attemptId,
      team_id: selectedTeam.id,
      station_id: station.id,
      state: "scored",
      arrived_at: arrivedAtIso ?? new Date(nowAdj).toISOString(),
      started_at: startedAtMs ? new Date(startedAtMs).toISOString() : new Date(nowAdj).toISOString(),
      ended_at: new Date(finalEndMs).toISOString(),
      scored_at: null,
      completed,
      time_ms: elapsedMs,
      progress: station.widget === "counter_countdown" ? countValue : progress,
      counters,
      bonus_correct: station.bonus ? bonusCorrect : null,
      variant: stampedVariant,
      practice: settings?.event_state === "live" ? false : practiceMode,
      voided: false,
      version: 1,
      session_id: session.session_id
    };

    await enqueueWrite("attempts", attemptId, payload as unknown as Record<string, unknown>);
    await offlineDb.meta.delete(ACTIVE_RUN_META_KEY);
    setLastSubmittedId(attemptId);
    setLastAttemptSynced(false);
    setUndoError(null);
    setUndoDeadlineMs(Date.now() + 60_000);
    setUndoSecondsLeft(60);

    setResetId(crypto.randomUUID());
    setResetStartedAtMs(finalEndMs);
    setResetItemsDone(0);
    setTeamInput("");
    setLookupError(null);
    setPhase("reset");

    await refreshSyncCounters(session);
  }

  // P1 #7: Offline-safe Host Undo
  // If the attempt has not yet synced to Postgres, cancel it directly from Dexie outbox.
  async function handleUndo() {
    if (!session || !lastSubmittedId) return;
    setUndoError(null);

    const ob = await offlineDb.outbox.get(lastSubmittedId);
    if (ob && ob.status !== "synced") {
      await offlineDb.outbox.delete(lastSubmittedId);
      await offlineDb.local_attempts.delete(lastSubmittedId);
      const pending = await offlineDb.outbox.where("status").anyOf("queued", "failed", "syncing").count();
      setPendingCount(pending);
      setConflicts(await getConflictItems());
    } else {
      if (!navigator.onLine) {
        setUndoError("Offline: reconnect to undo synced attempt");
        return;
      }
      const supabase = getSupabaseClient(session);
      const { error } = await supabase.rpc("host_undo", {
        p_attempt_id: lastSubmittedId,
        p_undone_at: new Date(serverAdjustedNow(clockOffsetMs)).toISOString()
      });

      if (error) {
        setUndoError(error.message);
        return;
      }
      await offlineDb.local_attempts.update(lastSubmittedId, { voided: true });
    }

    setAttemptId(crypto.randomUUID());
    setLastSubmittedId(null);
    setUndoDeadlineMs(null);
    setResetId(null);
    setResetStartedAtMs(null);
    setPhase("review");
  }

  async function handleResetDone(itemsDone: number) {
    await recordResetLog(false, itemsDone);
    setSelectedTeam(null);
    setAttemptId(null);
    setTeamInput("");
    setLookupError(null);
    setPhase("scan");
  }

  const remainingMs = Math.max(0, capMs - elapsedMs);
  const runningBgClass = useMemo(() => {
    if (phase !== "running") return "bg-bg";
    if (capFlash || remainingMs <= 0) return "bg-danger/20";
    if (remainingMs <= 10_000) return "bg-warning/20";
    return "bg-success/15";
  }, [phase, capFlash, remainingMs]);

  const notEnoughHoverTime = remainingMs < hoverHoldMs;
  const canGoBackFromReview = Boolean(station?.bonus) || (!completed && Boolean(station?.progress));

  if (!session) return null;

  return (
    <div className={"min-h-[100dvh] flex flex-col " + runningBgClass}>
      {practiceMode && (
        <div className="bg-warning text-white text-center text-xs font-semibold py-1.5 px-3">
          {t("common.practice_banner")}
        </div>
      )}

      {/* Top bar */}
      <header className="safe-pt px-4 pb-3 border-b border-border bg-surface flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted font-medium">Station {session.station_id}</p>
          <h1 className="text-base font-semibold truncate">{station?.name ?? t("common.loading")}</h1>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium " +
              (online ? "bg-success/15 text-success" : "bg-danger/15 text-danger")
            }
          >
            {online ? <Wifi className="w-3.5 h-3.5" /> : <CloudOff className="w-3.5 h-3.5" />}
            {online
              ? pendingCount > 0
                ? pendingCount + " " + t("common.queued")
                : t("common.synced")
              : t("common.offline")}
          </span>
          {settings?.event_state !== "live" && (phase === "scan" || phase === "reset") && (
            <button
              type="button"
              onClick={() => setPracticeMode((p) => !p)}
              className={
                "h-9 px-3 rounded-card border text-xs font-medium " +
                (practiceMode ? "border-warning bg-warning/15 text-warning" : "border-border text-muted")
              }
            >
              {t("host.practice_mode")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              clearSession();
              router.replace("/login");
            }}
            aria-label={t("common.sign_out")}
            className="h-9 px-2.5 rounded-card border border-border text-muted flex items-center gap-1 text-xs"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{t("common.sign_out")}</span>
          </button>
        </div>
      </header>

      {/* Non-retriable outbox conflict banner */}
      {conflicts.length > 0 && (
        <div className="bg-danger/15 border-b border-danger/40 px-4 py-2.5 text-xs text-danger space-y-1.5">
          {conflicts.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">
                Sync rejected ({c.table}): {c.last_error ?? "Conflict"}
              </span>
              <button
                type="button"
                onClick={async () => {
                  await dismissConflict(c.id);
                  setConflicts(await getConflictItems());
                }}
                className="px-2 py-1 rounded border border-danger/50 font-semibold shrink-0"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main zone */}
      <main className="flex-1 p-4 flex flex-col justify-between max-w-md w-full mx-auto gap-4">
        {!station ? (
          <p className="text-sm text-muted text-center my-auto">{t("host.no_station_config")}</p>
        ) : phase === "scan" || phase === "reset" ? (
          <div className="space-y-4">
            {phase === "reset" && resetStartedAtMs !== null && (
              <ResetPanel
                station={station}
                startedAtMs={resetStartedAtMs}
                clockOffsetMs={clockOffsetMs}
                inbound={inboundTeam}
                currentVariant={settings?.current_variant ?? null}
                undoSecondsLeft={undoSecondsLeft}
                lastAttemptSynced={lastAttemptSynced}
                undoError={undoError}
                onUndo={handleUndo}
                onChecklistChange={setResetItemsDone}
                onResetDone={handleResetDone}
              />
            )}

            {cameraOpen ? (
              <QrScanner
                compact={phase === "reset"}
                onScan={(code) => void resolveAndSelectTeam({ token: code })}
                onClose={() => setCameraOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                className="w-full h-14 rounded-card bg-accent text-white font-semibold inline-flex items-center justify-center gap-2"
              >
                <Camera className="w-5 h-5" />
                <span>{t("host.scan_camera")}</span>
              </button>
            )}

            <div className="bg-surface border border-border rounded-card p-4 shadow-soft space-y-3">
              <label htmlFor="team-num-input" className="block text-xs font-semibold text-muted">
                {t("host.scan_title")}
              </label>
              <div className="flex gap-2">
                <input
                  id="team-num-input"
                  type="tel"
                  inputMode="numeric"
                  value={teamInput}
                  onChange={(e) => setTeamInput(e.target.value.replace(/\D/g, ""))}
                  placeholder={t("host.team_placeholder")}
                  className="flex-1 h-14 px-4 rounded-card border border-border bg-bg text-text text-xl font-semibold text-center tabular-nums"
                />
                <button
                  type="button"
                  onClick={handleLookupNumber}
                  className="h-14 px-5 rounded-card border border-border bg-surface font-semibold"
                >
                  {t("host.lookup")}
                </button>
              </div>
              {lookupError && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {lookupError}
                </p>
              )}
            </div>
          </div>
        ) : phase === "ready" && selectedTeam ? (
          <>
            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold tabular-nums">Team #{selectedTeam.number}</span>
                <span className="text-sm font-medium text-muted">
                  {t("host.route_label")} {String.fromCharCode(65 + (selectedTeam.route % 7))}
                </span>
              </div>
              <p className="text-base font-medium">{selectedTeam.church}</p>
              {station.id === 7 && stampedVariant && (
                <p className="text-sm font-medium text-accent">
                  {t("host.variant_label")}: {stampedVariant}
                </p>
              )}
              {wrongStationWarn && (
                <div className="flex items-center gap-2 p-3 rounded-card bg-warning/15 text-warning text-sm font-medium">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{t("host.wrong_station")}</span>
                </div>
              )}
              <p className="text-sm text-muted pt-2 border-t border-border">{station.rule}</p>
            </div>

            <div className="safe-pb grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => void handleCancelBeforeStart()}
                className="h-14 rounded-card border border-border bg-surface text-text font-semibold"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleStart()}
                className="col-span-2 h-14 rounded-card bg-success text-white font-semibold flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5" />
                <span>{t("common.start")}</span>
              </button>
            </div>
          </>
        ) : phase === "running" && selectedTeam ? (
          <>
            <div className="text-center space-y-2 pt-4">
              <p className="text-sm font-medium text-muted">
                Team #{selectedTeam.number} · {selectedTeam.church}
              </p>
              <div className="text-6xl font-bold tabular-nums tracking-tight">
                {station.widget === "counter_countdown"
                  ? formatClockSeconds(remainingMs)
                  : formatDurationMs(elapsedMs)}
              </div>
              <p className="text-sm text-muted tabular-nums">
                {t("host.cap_reached")}: {formatClockSeconds(remainingMs)}
              </p>

              {station.widget === "counter_countdown" && (
                <div className="pt-4">
                  <p className="text-5xl font-bold tabular-nums text-accent">{countValue}</p>
                </div>
              )}

              {station.widget === "hover_hold" && hoverStartedAtMs !== null && (
                <div className="mt-4 p-4 rounded-card bg-accent/15 border border-accent">
                  <p className="text-4xl font-bold tabular-nums text-accent">
                    {(hoverRemainingMs / 1000).toFixed(1)}s
                  </p>
                </div>
              )}

              {holdRemainingMs > 0 && (
                <div className="mt-4 p-4 rounded-card bg-warning text-white font-bold text-2xl tabular-nums">
                  {t("host.foot_down")}: {(holdRemainingMs / 1000).toFixed(1)}s
                </div>
              )}
            </div>

            <div className="safe-pb space-y-3">
              {station.helpers.map((h) => {
                if (h.type === "hold_overlay") {
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => {
                        const durMs = (h.hold_s ?? 3) * 1000;
                        const nowAdj = serverAdjustedNow(clockOffsetMs);
                        setHoldEndsAtMs(nowAdj + durMs);
                        setHoldRemainingMs(durMs);
                        setCounters((c) => ({ ...c, [h.id]: (c[h.id] ?? 0) + 1 }));
                      }}
                      className="w-full h-14 rounded-card border border-warning bg-warning/15 text-warning font-semibold"
                    >
                      {t("host.foot_down")} ({counters[h.id] ?? 0})
                    </button>
                  );
                }
                if (h.type === "counter") {
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => setCounters((c) => ({ ...c, [h.id]: (c[h.id] ?? 0) + 1 }))}
                      className="w-full h-14 rounded-card border border-border bg-surface text-text font-semibold tabular-nums"
                    >
                      {t("host.drop_counter")} ({counters[h.id] ?? 0})
                    </button>
                  );
                }
                return null;
              })}

              {station.widget === "stopwatch_progress" && (
                <button
                  type="button"
                  onClick={() => finishRun(true, elapsedMs)}
                  className="w-full h-16 rounded-card bg-danger text-white text-lg font-semibold flex items-center justify-center gap-2"
                >
                  <Square className="w-5 h-5" />
                  <span>{t("common.stop")}</span>
                </button>
              )}

              {station.widget === "counter_countdown" && (
                <div className="grid grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => setCountValue((v) => Math.max(0, v - 1))}
                    className="h-16 rounded-card border border-border bg-surface text-xl font-bold"
                  >
                    -1
                  </button>
                  <button
                    type="button"
                    onClick={() => setCountValue((v) => v + 1)}
                    className="col-span-2 h-16 rounded-card bg-accent text-white text-2xl font-bold"
                  >
                    +1
                  </button>
                </div>
              )}

              {station.widget === "hover_hold" && (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={hoverStartedAtMs === null}
                    onClick={() => {
                      setHoverStartedAtMs(null);
                      setHoverRemainingMs(0);
                      setCounters((c) => ({ ...c, ground_touch: (c.ground_touch ?? 0) + 1 }));
                    }}
                    className="h-16 rounded-card border border-danger bg-danger/10 text-danger font-semibold disabled:opacity-40"
                  >
                    {t("host.hover_reset")} ({counters.ground_touch ?? 0})
                  </button>
                  <button
                    type="button"
                    disabled={hoverStartedAtMs !== null || notEnoughHoverTime}
                    onClick={() => {
                      const nowAdj = serverAdjustedNow(clockOffsetMs);
                      setHoverStartedAtMs(nowAdj);
                      setHoverRemainingMs(hoverHoldMs);
                    }}
                    className="h-16 rounded-card bg-accent text-white font-semibold disabled:opacity-50"
                  >
                    {notEnoughHoverTime ? t("host.not_enough_time") : t("host.hover_start")}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : phase === "result" ? (
          <>
            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-4">
              <h2 className="text-base font-semibold">{t("host.result_title")}</h2>
              {station.progress?.kind === "taps" && (
                <div className="grid grid-cols-4 gap-2">
                  {station.progress.values.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setProgress(val)}
                      className={
                        "h-14 rounded-card border font-semibold tabular-nums " +
                        (progress === val
                          ? "bg-accent text-white border-accent"
                          : "bg-bg text-text border-border")
                      }
                    >
                      {val} {station.progress?.unit}
                    </button>
                  ))}
                </div>
              )}
              {station.progress?.kind === "stepper" && (
                <div className="flex items-center justify-between gap-4">
                  <button
                    type="button"
                    onClick={() =>
                      setProgress((p) =>
                        Math.max(
                          station.progress!.kind === "stepper" ? station.progress!.min : 0,
                          (p ?? 0) -
                            (station.progress!.kind === "stepper" ? station.progress!.step : 5)
                        )
                      )
                    }
                    className="h-14 w-16 rounded-card border border-border text-xl font-bold"
                  >
                    -
                  </button>
                  <span className="text-3xl font-bold tabular-nums">
                    {progress ?? station.progress.min} {station.progress.unit}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setProgress((p) =>
                        Math.min(
                          station.progress!.kind === "stepper" ? station.progress!.max : 150,
                          (p ?? 0) +
                            (station.progress!.kind === "stepper" ? station.progress!.step : 5)
                        )
                      )
                    }
                    className="h-14 w-16 rounded-card border border-border text-xl font-bold"
                  >
                    +
                  </button>
                </div>
              )}
            </div>
            <div className="safe-pb">
              <button
                type="button"
                disabled={progress === null}
                onClick={() => setPhase(station.bonus ? "bonus" : "review")}
                className="w-full h-14 rounded-card bg-accent text-white font-semibold disabled:opacity-50"
              >
                {t("common.continue")}
              </button>
            </div>
          </>
        ) : phase === "bonus" && station.bonus ? (
          <>
            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-3">
              <h2 className="text-sm font-semibold text-muted">{t("host.bonus_title")}</h2>
              <p className="text-base font-medium">{station.bonus.q}</p>
              <p className="text-sm text-success font-semibold pt-2 border-t border-border">
                {station.bonus.a}
              </p>
            </div>
            <div className="safe-pb grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setBonusCorrect(false);
                  setPhase("review");
                }}
                className="h-14 rounded-card border border-danger bg-danger/10 text-danger font-semibold flex items-center justify-center gap-2"
              >
                <X className="w-5 h-5" />
                <span>{t("common.wrong")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setBonusCorrect(true);
                  setPhase("review");
                }}
                className="h-14 rounded-card bg-success text-white font-semibold flex items-center justify-center gap-2"
              >
                <Check className="w-5 h-5" />
                <span>{t("common.correct")}</span>
              </button>
            </div>
          </>
        ) : (
          selectedTeam && (
            <>
              <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-3">
                <h2 className="text-base font-semibold">{t("host.review_title")}</h2>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Team</span>
                  <span className="font-semibold tabular-nums">
                    #{selectedTeam.number} · {selectedTeam.church}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Outcome</span>
                  <span className="font-semibold">
                    {completed ? t("host.completed") : t("host.dnf")}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Time</span>
                  <span className="font-semibold tabular-nums">{formatDurationMs(elapsedMs)}</span>
                </div>

                {station.widget === "counter_countdown" ? (
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-sm text-muted">Count</span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setCountValue((v) => {
                            const next = Math.max(0, v - 1);
                            setProgress(next);
                            return next;
                          });
                        }}
                        className="h-10 w-12 rounded-card border border-border font-bold"
                      >
                        -1
                      </button>
                      <span className="text-lg font-bold tabular-nums min-w-[2ch] text-center">
                        {countValue}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setCountValue((v) => {
                            const next = v + 1;
                            setProgress(next);
                            return next;
                          });
                        }}
                        className="h-10 w-12 rounded-card border border-border font-bold"
                      >
                        +1
                      </button>
                    </div>
                  </div>
                ) : (
                  progress !== null && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted">Progress</span>
                      <span className="font-semibold tabular-nums">{progress}</span>
                    </div>
                  )
                )}

                {station.bonus && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Bonus</span>
                    <span className="font-semibold">
                      {bonusCorrect ? t("common.correct") : t("common.wrong")}
                    </span>
                  </div>
                )}
              </div>
              <div className={"safe-pb grid gap-3 " + (canGoBackFromReview ? "grid-cols-3" : "grid-cols-1")}>
                {canGoBackFromReview && (
                  <button
                    type="button"
                    onClick={() => setPhase(station.bonus ? "bonus" : "result")}
                    className="h-14 rounded-card border border-border bg-surface font-semibold"
                  >
                    {t("common.back")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleSubmitAttempt()}
                  className={
                    "h-14 rounded-card bg-accent text-white font-semibold " +
                    (canGoBackFromReview ? "col-span-2" : "w-full")
                  }
                >
                  {t("common.submit")}
                </button>
              </div>
            </>
          )
        )}
      </main>
    </div>
  );
}
