"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import {
  AlertTriangle,
  Camera,
  ClipboardList,
  Download,
  Flag,
  KeyRound,
  LogOut,
  Printer,
  Radio,
  Settings,
  Trophy,
  Users,
  X
} from "lucide-react";
import { clearSession, loadSession } from "@/lib/auth/session";
import { t } from "@/lib/i18n";
import { computeOpsBoard } from "@/lib/ops";
import type { ResetLogInput } from "@/lib/reset";
import { computeScoring, type LeaderboardRow, type StationScoringConfig } from "@/lib/scoring";
import { getSupabaseClient } from "@/lib/supabase/client";
import { formatDurationMs } from "@/lib/timer/clock";
import type {
  AttemptRow,
  AuditLogRow,
  EventSettingsRow,
  RoleSession,
  StationConfig,
  TeamRow
} from "@/lib/types/domain";
import { QrScanner } from "@/components/qr/QrScanner";
import { HubDispatchTab } from "@/components/hub/HubDispatchTab";
import { HubExportTab } from "@/components/hub/HubExportTab";
import { HubRolesTab } from "@/components/hub/HubRolesTab";
import { HubStationsTab } from "@/components/hub/HubStationsTab";

type HubTab =
  | "leaderboard"
  | "dispatch"
  | "teams"
  | "stations"
  | "attempts"
  | "roles"
  | "settings"
  | "export";

function randomTeamToken(): string {
  const chars = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function HubApp() {
  const router = useRouter();
  const [session, setSession] = useState<RoleSession | null>(null);
  const [tab, setTab] = useState<HubTab>("leaderboard");

  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [stations, setStations] = useState<StationConfig[]>([]);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [resets, setResets] = useState<ResetLogInput[]>([]);
  const [activeStationIds, setActiveStationIds] = useState<Set<number>>(new Set());
  const [settings, setSettings] = useState<EventSettingsRow | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogRow[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [search, setSearch] = useState("");
  const [churchFilter, setChurchFilter] = useState("ALL");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [drawerTeamId, setDrawerTeamId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [newNumber, setNewNumber] = useState("");
  const [newChurch, setNewChurch] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [hubScanMode, setHubScanMode] = useState<"launch" | "finish" | null>(null);

  const [editingAttempt, setEditingAttempt] = useState<AttemptRow | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editVoided, setEditVoided] = useState(false);
  const [editBonus, setEditBonus] = useState<string>("null");
  const [editTimeMs, setEditTimeMs] = useState("");

  const loadAll = async (s: RoleSession) => {
    const supabase = getSupabaseClient(s);
    const [tmRes, stRes, attRes, rstRes, sessRes, setRes, audRes] = await Promise.all([
      supabase.from("teams").select("*").order("number", { ascending: true }),
      supabase.from("stations").select("config").order("id", { ascending: true }),
      supabase.from("attempts").select("*").order("updated_at", { ascending: false }),
      supabase.from("station_resets").select("id,station_id,started_at,done_at,items_done,skipped").order("started_at", { ascending: false }),
      supabase.from("role_sessions").select("station_id").is("revoked_at", null).not("station_id", "is", null),
      supabase.from("event_settings").select("*").eq("id", 1).maybeSingle(),
      supabase.from("audit_log").select("*").order("ts", { ascending: false }).limit(50)
    ]);

    if (tmRes.data) setTeams(tmRes.data as TeamRow[]);
    if (stRes.data) setStations(stRes.data.map((r) => r.config as StationConfig));
    if (attRes.data) setAttempts(attRes.data as AttemptRow[]);
    if (rstRes.data) setResets(rstRes.data as ResetLogInput[]);
    if (sessRes.data) {
      setActiveStationIds(new Set(sessRes.data.map((r) => Number(r.station_id))));
    }
    if (setRes.data) setSettings(setRes.data as EventSettingsRow);
    if (audRes.data) setAuditLog(audRes.data as AuditLogRow[]);
  };

  useEffect(() => {
    const s = loadSession();
    if (!s || s.role !== "hub") {
      router.replace("/login");
      return;
    }
    setSession(s);
    void loadAll(s);

    const supabase = getSupabaseClient(s);
    const channel = supabase
      .channel("hub-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "attempts" }, () => void loadAll(s))
      .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, () => void loadAll(s))
      .on("postgres_changes", { event: "*", schema: "public", table: "station_resets" }, () => void loadAll(s))
      .on("postgres_changes", { event: "*", schema: "public", table: "event_settings" }, () => void loadAll(s))
      .subscribe();

    const pollId = window.setInterval(() => {
      setNowMs(Date.now());
      void loadAll(s);
    }, 5000);
    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(pollId);
    };
  }, [router]);

  const scoringConfigs: StationScoringConfig[] = useMemo(
    () =>
      stations.map((st) => ({
        id: st.id,
        name: st.name,
        rank: st.rank,
        dnf_zero: st.dnf_zero,
        bonus_on_dnf: st.bonus_on_dnf ?? true,
        has_bonus: st.bonus !== null
      })),
    [stations]
  );

  const scoring = useMemo(
    () =>
      computeScoring(teams, scoringConfigs, attempts, {
        n_mode: settings?.scoring_n_mode ?? "provisional",
        variant_ranking_mode: settings?.variant_ranking_mode ?? "across"
      }),
    [teams, scoringConfigs, attempts, settings]
  );

  const opsBoard = useMemo(
    () =>
      computeOpsBoard({
        stations,
        teams,
        attempts,
        resets,
        activeStationIds,
        walkTimeS: settings?.walk_time_s ?? 30,
        nowMs
      }),
    [stations, teams, attempts, resets, activeStationIds, settings, nowMs]
  );

  const churches = useMemo(() => Array.from(new Set(teams.map((tm) => tm.church))).sort(), [teams]);

  const filteredRows = useMemo(() => {
    return scoring.leaderboard.filter((row) => {
      if (churchFilter !== "ALL" && row.church !== churchFilter) return false;
      if (search.trim() !== "" && !String(row.team_number).includes(search.trim())) return false;
      return true;
    });
  }, [scoring.leaderboard, churchFilter, search]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "j") {
        setSelectedIndex((i) => Math.min(filteredRows.length - 1, i + 1));
      } else if (e.key === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "e") {
        const row = filteredRows[selectedIndex];
        if (row) setDrawerTeamId(row.team_id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filteredRows, selectedIndex]);

  const columns = useMemo<ColumnDef<LeaderboardRow>[]>(() => {
    const base: ColumnDef<LeaderboardRow>[] = [
      {
        accessorKey: "overall_rank",
        header: "#",
        cell: (info) => <span className="font-semibold tabular-nums">{String(info.getValue())}</span>
      },
      {
        accessorKey: "team_number",
        header: "Team",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-semibold tabular-nums">#{row.original.team_number}</span>
            <span className="text-muted truncate max-w-[140px]">{row.original.church}</span>
            {row.original.missing_finish_alert && (
              <span className="px-1.5 py-0.5 rounded bg-warning/15 text-warning text-[11px] font-semibold">
                {t("hub.missing_finish")}
              </span>
            )}
          </div>
        )
      }
    ];

    for (const st of stations) {
      base.push({
        id: "st_" + st.id,
        header: "S" + st.id,
        accessorFn: (r) => r.stations[st.id]?.total_points ?? 0,
        cell: ({ row }) => {
          const cell = row.original.stations[st.id];
          if (!cell || !cell.played) return <span className="text-muted tabular-nums">—</span>;
          return (
            <div className="tabular-nums text-xs">
              <span className="font-semibold">{cell.total_points.toFixed(1)}</span>
              <span className="text-muted ml-1">{cell.rank !== null ? "#" + cell.rank : "DNF"}</span>
            </div>
          );
        }
      });
    }

    base.push({
      accessorKey: "grand_total",
      header: "Total",
      cell: (info) => (
        <span className="font-bold tabular-nums text-accent">{Number(info.getValue()).toFixed(1)}</span>
      )
    });

    return base;
  }, [stations]);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  async function handleAddTeam(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    setFormMsg(null);
    const num = Number.parseInt(newNumber, 10);
    if (Number.isNaN(num) || !newChurch.trim()) return;

    const supabase = getSupabaseClient(session);
    const { error } = await supabase.from("teams").insert({
      number: num,
      church: newChurch.trim(),
      team_name: newTeamName.trim() || null,
      token: randomTeamToken(),
      checked_in_at: new Date().toISOString()
    });

    if (error) {
      setFormMsg(error.message);
    } else {
      setNewNumber("");
      setNewChurch("");
      setNewTeamName("");
      await loadAll(session);
    }
  }

  async function updateTeamTimestamp(teamId: string, field: "checked_in_at" | "started_at" | "finished_at") {
    if (!session) return;
    const supabase = getSupabaseClient(session);
    await supabase.from("teams").update({ [field]: new Date().toISOString() }).eq("id", teamId);
    await loadAll(session);
  }

  async function handleHubQrScan(token: string) {
    if (!session || !hubScanMode) return;
    const found = teams.find((tm) => tm.token.toUpperCase() === token.trim().toUpperCase());
    setHubScanMode(null);
    if (!found) {
      setFormMsg(t("host.unknown_team"));
      return;
    }
    await updateTeamTimestamp(found.id, hubScanMode === "launch" ? "started_at" : "finished_at");
  }

  async function handleSaveAttemptEdit(e: FormEvent) {
    e.preventDefault();
    if (!session || !editingAttempt || !editReason.trim()) return;
    const supabase = getSupabaseClient(session);
    const patch: Record<string, unknown> = {
      voided: editVoided,
      bonus_correct: editBonus === "null" ? null : editBonus === "true"
    };
    if (editTimeMs.trim() !== "") {
      patch.time_ms = Number.parseInt(editTimeMs, 10);
    }
    await supabase.rpc("hub_edit_attempt", {
      p_attempt_id: editingAttempt.id,
      p_patch: patch,
      p_reason: editReason.trim()
    });
    setEditingAttempt(null);
    setEditReason("");
    await loadAll(session);
  }

  async function handleSettingPatch(patch: Record<string, unknown>, reason: string) {
    if (!session) return;
    const supabase = getSupabaseClient(session);
    await supabase.rpc("hub_update_event_settings", {
      p_patch: patch,
      p_reason: reason
    });
    await loadAll(session);
  }

  const drawerTeam = teams.find((tm) => tm.id === drawerTeamId) ?? null;
  const drawerRow = scoring.leaderboard.find((r) => r.team_id === drawerTeamId) ?? null;

  const navItems: { id: HubTab; label: string; icon: typeof Trophy }[] = [
    { id: "leaderboard", label: t("hub.tab_leaderboard"), icon: Trophy },
    { id: "dispatch", label: t("hub.tab_dispatch"), icon: Radio },
    { id: "teams", label: t("hub.tab_teams"), icon: Users },
    { id: "stations", label: t("hub.tab_stations"), icon: Flag },
    { id: "attempts", label: t("hub.tab_attempts"), icon: ClipboardList },
    { id: "roles", label: t("hub.tab_roles"), icon: KeyRound },
    { id: "settings", label: t("hub.tab_settings"), icon: Settings },
    { id: "export", label: t("hub.tab_export"), icon: Download }
  ];

  if (!session) return null;

  return (
    <div className="min-h-[100dvh] flex flex-col lg:flex-row bg-bg">
      <aside className="hidden lg:flex lg:w-56 flex-col border-r border-border bg-surface p-3 gap-1 shrink-0">
        <div className="px-3 py-2 flex items-center justify-between">
          <span className="font-semibold text-sm">{t("app.title")} · Hub</span>
          <span
            className={
              "px-2 py-0.5 rounded text-[11px] font-semibold " +
              (settings?.event_state === "live" ? "bg-success/15 text-success" : "bg-warning/15 text-warning")
            }
          >
            {settings?.event_state?.toUpperCase() ?? "PRACTICE"}
          </span>
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={
                "flex items-center gap-2.5 px-3 py-2.5 rounded-card text-sm font-medium text-left " +
                (active ? "bg-accent text-white" : "text-text hover:bg-bg")
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            clearSession();
            router.replace("/login");
          }}
          className="mt-auto flex items-center gap-2.5 px-3 py-2.5 rounded-card text-sm font-medium text-muted hover:bg-bg"
        >
          <LogOut className="w-4 h-4" />
          <span>{t("common.sign_out")}</span>
        </button>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col pb-20 lg:pb-0">
        {tab === "leaderboard" && (
          <div className="p-4 lg:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{t("hub.tab_leaderboard")}</h1>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/15 text-accent">
                  {scoring.provisional ? t("hub.provisional") : t("hub.final")}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={searchInputRef}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("hub.search_placeholder")}
                  className="h-10 px-3 rounded-card border border-border bg-surface text-sm w-44"
                />
                <select
                  value={churchFilter}
                  onChange={(e) => setChurchFilter(e.target.value)}
                  aria-label="Filter by church"
                  className="h-10 px-3 rounded-card border border-border bg-surface text-sm"
                >
                  <option value="ALL">{t("hub.all_churches")}</option>
                  {churches.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {scoring.variant_warnings.length > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-card bg-warning/15 text-warning text-sm font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  {t("hub.variant_warning")}:{" "}
                  {scoring.variant_warnings.map((w) => w.variant + " (" + w.attempt_count + ")").join(", ")}
                </span>
              </div>
            )}

            {filteredRows.length === 0 ? (
              <p className="text-sm text-muted py-8 text-center bg-surface border border-border rounded-card">
                {t("hub.empty_teams")}
              </p>
            ) : (
              <div className="bg-surface border border-border rounded-card shadow-soft overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="border-b border-border text-xs text-muted">
                    {table.getHeaderGroups().map((hg) => (
                      <tr key={hg.id}>
                        {hg.headers.map((header) => (
                          <th
                            key={header.id}
                            onClick={header.column.getToggleSortingHandler()}
                            className="px-3 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                  <tbody className="divide-y divide-border">
                    {table.getRowModel().rows.map((row, idx) => (
                      <tr
                        key={row.id}
                        onClick={() => {
                          setSelectedIndex(idx);
                          setDrawerTeamId(row.original.team_id);
                        }}
                        className={"cursor-pointer hover:bg-bg " + (idx === selectedIndex ? "bg-accent/5" : "")}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id} className="px-3 py-2.5 whitespace-nowrap">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "dispatch" && (
          <HubDispatchTab
            board={opsBoard}
            onLaunchTeam={(teamId) => updateTeamTimestamp(teamId, "started_at")}
          />
        )}

        {tab === "teams" && (
          <div className="p-4 lg:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-lg font-semibold">{t("hub.tab_teams")}</h1>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setHubScanMode("launch")}
                  className="h-9 px-3 rounded-card border border-border bg-surface text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{t("hub.scan_launch")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setHubScanMode("finish")}
                  className="h-9 px-3 rounded-card border border-border bg-surface text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{t("hub.scan_finish")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/hub/print-cards")}
                  className="h-9 px-3 rounded-card bg-accent text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>{t("common.print")}</span>
                </button>
              </div>
            </div>

            {hubScanMode && (
              <div className="max-w-sm">
                <QrScanner
                  compact
                  onScan={(code) => void handleHubQrScan(code)}
                  onClose={() => setHubScanMode(null)}
                />
              </div>
            )}

            <form
              onSubmit={handleAddTeam}
              className="bg-surface border border-border rounded-card p-4 shadow-soft grid grid-cols-1 md:grid-cols-4 gap-3"
            >
              <input
                type="number"
                required
                min={1}
                max={settings?.max_teams ?? 30}
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                placeholder="Team #"
                className="h-11 px-3 rounded-card border border-border bg-bg"
              />
              <input
                type="text"
                required
                value={newChurch}
                onChange={(e) => setNewChurch(e.target.value)}
                placeholder="Church"
                className="h-11 px-3 rounded-card border border-border bg-bg"
              />
              <input
                type="text"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="Team name (optional)"
                className="h-11 px-3 rounded-card border border-border bg-bg"
              />
              <button type="submit" className="h-11 px-4 rounded-card bg-accent text-white font-semibold">
                {t("hub.add_team")}
              </button>
              {formMsg && <p className="text-sm text-danger md:col-span-4">{formMsg}</p>}
            </form>

            {teams.length === 0 ? (
              <p className="text-sm text-muted py-8 text-center bg-surface border border-border rounded-card">
                {t("hub.empty_teams")}
              </p>
            ) : (
              <div className="bg-surface border border-border rounded-card shadow-soft divide-y divide-border">
                {teams.map((tm) => (
                  <div key={tm.id} className="p-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                    <div>
                      <span className="font-semibold tabular-nums">#{tm.number}</span>{" "}
                      <span>{tm.church}</span>{" "}
                      <span className="text-muted text-xs">
                        (Route {String.fromCharCode(65 + (tm.route % 7))} · {tm.token})
                      </span>
                      {tm.withdrawn && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-danger/15 text-danger text-xs">
                          Withdrawn
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!tm.checked_in_at && (
                        <button
                          type="button"
                          onClick={() => updateTeamTimestamp(tm.id, "checked_in_at")}
                          className="h-9 px-3 rounded-card border border-border text-xs font-medium"
                        >
                          {t("hub.check_in")}
                        </button>
                      )}
                      {!tm.started_at && (
                        <button
                          type="button"
                          onClick={() => updateTeamTimestamp(tm.id, "started_at")}
                          className="h-9 px-3 rounded-card bg-accent text-white text-xs font-medium"
                        >
                          {t("hub.launch")}
                        </button>
                      )}
                      {tm.started_at && !tm.finished_at && (
                        <button
                          type="button"
                          onClick={() => updateTeamTimestamp(tm.id, "finished_at")}
                          className="h-9 px-3 rounded-card bg-success text-white text-xs font-medium"
                        >
                          {t("hub.finish")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "stations" && (
          <HubStationsTab
            session={session}
            stations={stations}
            attempts={attempts}
            resets={resets}
            activeStationIds={activeStationIds}
            onUpdated={() => loadAll(session)}
          />
        )}

        {tab === "roles" && <HubRolesTab session={session} />}

        {tab === "attempts" && (
          <div className="p-4 lg:p-6 space-y-6">
            <h1 className="text-lg font-semibold">{t("hub.tab_attempts")}</h1>
            {attempts.length === 0 ? (
              <p className="text-sm text-muted py-8 text-center bg-surface border border-border rounded-card">
                {t("hub.empty_attempts")}
              </p>
            ) : (
              <div className="bg-surface border border-border rounded-card shadow-soft divide-y divide-border">
                {attempts.slice(0, 40).map((att) => {
                  const tm = teams.find((x) => x.id === att.team_id);
                  return (
                    <div key={att.id} className="p-3 flex items-center justify-between gap-2 text-sm">
                      <div className="tabular-nums">
                        <span className="font-semibold">Team #{tm?.number ?? "?"}</span> · Stn {att.station_id} ·{" "}
                        {att.time_ms !== null ? formatDurationMs(att.time_ms) : "—"} ·{" "}
                        {att.voided ? "VOID" : att.completed ? t("host.completed") : t("host.dnf")}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingAttempt(att);
                          setEditVoided(att.voided);
                          setEditBonus(att.bonus_correct === null ? "null" : String(att.bonus_correct));
                          setEditTimeMs(att.time_ms !== null ? String(att.time_ms) : "");
                          setEditReason("");
                        }}
                        className="h-9 px-3 rounded-card border border-border text-xs font-medium"
                      >
                        {t("common.edit")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted">Audit trail</h2>
              {auditLog.length === 0 ? (
                <p className="text-sm text-muted">{t("hub.empty_audit")}</p>
              ) : (
                <div className="bg-surface border border-border rounded-card divide-y divide-border text-xs">
                  {auditLog.map((log) => (
                    <div key={log.id} className="p-2.5 flex justify-between gap-2">
                      <span>
                        <strong>{log.actor_role}</strong> · {log.table_name} · {log.reason}
                      </span>
                      <span className="text-muted tabular-nums">
                        {new Date(log.ts).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "settings" && settings && (
          <div className="p-4 lg:p-6 space-y-4 max-w-xl">
            <h1 className="text-lg font-semibold">{t("hub.tab_settings")}</h1>
            <div className="bg-surface border border-border rounded-card p-5 shadow-soft space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.event_state")}</span>
                <div className="flex gap-2">
                  {(["practice", "live"] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => handleSettingPatch({ event_state: st }, "hub_toggle_event_state")}
                      className={
                        "h-9 px-3 rounded-card border text-xs font-semibold " +
                        (settings.event_state === st ? "bg-accent text-white border-accent" : "border-border")
                      }
                    >
                      {st.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.n_mode")}</span>
                <div className="flex gap-2">
                  {(["provisional", "final"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleSettingPatch({ scoring_n_mode: mode }, "hub_toggle_n_mode")}
                      className={
                        "h-9 px-3 rounded-card border text-xs font-semibold " +
                        (settings.scoring_n_mode === mode ? "bg-accent text-white border-accent" : "border-border")
                      }
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.variant_mode")}</span>
                <div className="flex gap-2">
                  {(["across", "within"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleSettingPatch({ variant_ranking_mode: mode }, "hub_toggle_variant_mode")}
                      className={
                        "h-9 px-3 rounded-card border text-xs font-semibold " +
                        (settings.variant_ranking_mode === mode ? "bg-accent text-white border-accent" : "border-border")
                      }
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-medium">{t("hub.current_variant")}</span>
                <select
                  value={settings.current_variant}
                  onChange={(e) => handleSettingPatch({ current_variant: e.target.value }, "hub_change_variant")}
                  className="h-9 px-3 rounded-card border border-border bg-bg text-xs font-semibold"
                >
                  {settings.variant_labels.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {tab === "export" && (
          <HubExportTab
            session={session}
            scoring={scoring}
            stations={stations}
            onRefresh={() => loadAll(session)}
          />
        )}
      </div>

      {drawerTeam && drawerRow && (
        <aside className="fixed inset-y-0 right-0 w-full max-w-sm bg-surface border-l border-border shadow-soft p-5 z-40 overflow-y-auto space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold tabular-nums">Team #{drawerTeam.number}</h2>
              <p className="text-sm text-muted">{drawerTeam.church}</p>
            </div>
            <button
              type="button"
              onClick={() => setDrawerTeamId(null)}
              aria-label={t("common.close")}
              className="h-9 px-2.5 rounded-card border border-border flex items-center gap-1 text-xs"
            >
              <X className="w-4 h-4" />
              <span>{t("common.close")}</span>
            </button>
          </div>
          <div className="divide-y divide-border text-sm">
            {stations.map((st) => {
              const cell = drawerRow.stations[st.id];
              return (
                <div key={st.id} className="py-2.5 flex items-center justify-between">
                  <span>S{st.id} · {st.name}</span>
                  <span className="tabular-nums font-medium">
                    {cell?.played ? cell.total_points.toFixed(1) + " pts" : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {editingAttempt && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleSaveAttemptEdit}
            className="w-full max-w-md bg-surface border border-border rounded-card p-5 shadow-soft space-y-4"
          >
            <h2 className="text-base font-semibold">{t("common.edit")} · Stn {editingAttempt.station_id}</h2>
            <div className="space-y-2 text-sm">
              <label className="block">
                <span className="text-muted">Time (ms)</span>
                <input
                  type="number"
                  value={editTimeMs}
                  onChange={(e) => setEditTimeMs(e.target.value)}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg tabular-nums"
                />
              </label>
              <label className="block">
                <span className="text-muted">Bonus</span>
                <select
                  value={editBonus}
                  onChange={(e) => setEditBonus(e.target.value)}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg"
                >
                  <option value="null">N/A</option>
                  <option value="true">{t("common.correct")}</option>
                  <option value="false">{t("common.wrong")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  checked={editVoided}
                  onChange={(e) => setEditVoided(e.target.checked)}
                />
                <span>{t("common.void")}</span>
              </label>
              <label className="block">
                <span className="text-muted">{t("hub.reason_label")}</span>
                <input
                  type="text"
                  required
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder={t("hub.reason_required")}
                  className="mt-1 w-full h-11 px-3 rounded-card border border-border bg-bg"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingAttempt(null)}
                className="h-11 px-4 rounded-card border border-border text-sm font-medium"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={!editReason.trim()}
                className="h-11 px-4 rounded-card bg-accent text-white text-sm font-semibold disabled:opacity-50"
              >
                {t("common.save")}
              </button>
            </div>
          </form>
        </div>
      )}

      <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-surface border-t border-border safe-pb flex justify-around px-1 pt-1 z-30">
        {navItems.slice(0, 5).map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={
                "flex flex-col items-center gap-0.5 py-1.5 px-2 text-[11px] font-medium " +
                (active ? "text-accent" : "text-muted")
              }
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
