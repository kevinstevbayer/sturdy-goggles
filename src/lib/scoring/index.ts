import type {
  LeaderboardRow,
  ScoringAttempt,
  ScoringOptions,
  ScoringResult,
  ScoringTeam,
  StationScoringConfig,
  StationTeamScore,
  VariantWarning
} from "./types";

export * from "./types";

export function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function computeRankPoints(rank: number, n: number): number {
  if (n <= 0 || rank <= 0 || rank > n) {
    return 0;
  }
  return round1((10 * (n - rank + 1)) / n);
}

export function routeToLetter(route: number): string {
  const normalized = ((route % 7) + 7) % 7;
  return String.fromCharCode(65 + normalized);
}

function compareAttempts(
  a: ScoringAttempt,
  b: ScoringAttempt,
  station: StationScoringConfig
): number {
  if (station.rank === "count") {
    const aCount = a.progress ?? 0;
    const bCount = b.progress ?? 0;
    return bCount - aCount;
  }

  const aComp = a.completed === true;
  const bComp = b.completed === true;

  if (aComp !== bComp) {
    return aComp ? -1 : 1;
  }

  if (aComp && bComp) {
    const aTime = a.time_ms ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.time_ms ?? Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  }

  const aProg = a.progress ?? 0;
  const bProg = b.progress ?? 0;
  return bProg - aProg;
}

function computeBonusPoints(
  attempt: ScoringAttempt,
  station: StationScoringConfig
): number {
  if (!station.has_bonus || attempt.bonus_correct !== true) {
    return 0;
  }
  const allowBonusOnDnf = station.bonus_on_dnf ?? true;
  if (attempt.completed === true || allowBonusOnDnf) {
    return 1;
  }
  return 0;
}

function scoreAttemptGroup(
  group: ScoringAttempt[],
  station: StationScoringConfig,
  denominatorN: number
): Map<string, StationTeamScore> {
  const scores = new Map<string, StationTeamScore>();
  const isDnfZero = station.dnf_zero === true;

  const rankable: ScoringAttempt[] = [];
  const unrankedDnf: ScoringAttempt[] = [];

  for (const att of group) {
    if (isDnfZero && att.completed !== true) {
      unrankedDnf.push(att);
    } else {
      rankable.push(att);
    }
  }

  rankable.sort((a, b) => compareAttempts(a, b, station));

  let currentRank = 1;
  for (let i = 0; i < rankable.length; i++) {
    const att = rankable[i]!;
    if (i > 0 && compareAttempts(rankable[i - 1]!, att, station) !== 0) {
      currentRank = i + 1;
    }

    const gamePoints = computeRankPoints(currentRank, denominatorN);
    const bonusPoints = computeBonusPoints(att, station);

    scores.set(att.team_id, {
      station_id: station.id,
      played: true,
      attempt_id: att.id,
      completed: att.completed,
      time_ms: att.time_ms,
      progress: att.progress,
      variant: att.variant,
      rank: currentRank,
      n_used: denominatorN,
      game_points: gamePoints,
      bonus_points: bonusPoints,
      total_points: round1(gamePoints + bonusPoints)
    });
  }

  for (const att of unrankedDnf) {
    const bonusPoints = computeBonusPoints(att, station);
    scores.set(att.team_id, {
      station_id: station.id,
      played: true,
      attempt_id: att.id,
      completed: att.completed,
      time_ms: att.time_ms,
      progress: att.progress,
      variant: att.variant,
      rank: null,
      n_used: denominatorN,
      game_points: 0,
      bonus_points: bonusPoints,
      total_points: round1(bonusPoints)
    });
  }

  return scores;
}

export function computeScoring(
  teams: ScoringTeam[],
  stations: StationScoringConfig[],
  attempts: ScoringAttempt[],
  options: ScoringOptions
): ScoringResult {
  const activeTeams = teams.filter((t) => !t.withdrawn);
  const activeTeamIds = new Set(activeTeams.map((t) => t.id));
  const finalN = activeTeams.filter((t) => t.checked_in_at !== null).length;

  const validAttempts = attempts.filter(
    (a) =>
      a.state === "scored" &&
      !a.practice &&
      !a.voided &&
      activeTeamIds.has(a.team_id)
  );

  const attemptsByStation = new Map<number, ScoringAttempt[]>();
  for (const st of stations) {
    attemptsByStation.set(st.id, []);
  }
  for (const att of validAttempts) {
    const list = attemptsByStation.get(att.station_id);
    if (list) {
      list.push(att);
    }
  }

  const variantWarnings: VariantWarning[] = [];
  const stationScoresByStation = new Map<number, Map<string, StationTeamScore>>();

  for (const station of stations) {
    const stAttempts = attemptsByStation.get(station.id) ?? [];
    const useWithinVariant =
      station.id === 7 && options.variant_ranking_mode === "within";

    if (useWithinVariant) {
      const byVariant = new Map<string, ScoringAttempt[]>();
      for (const att of stAttempts) {
        const label = att.variant ?? "default";
        const bucket = byVariant.get(label) ?? [];
        bucket.push(att);
        byVariant.set(label, bucket);
      }

      const merged = new Map<string, StationTeamScore>();
      for (const [variantLabel, group] of byVariant.entries()) {
        if (group.length > 0 && group.length < 5) {
          variantWarnings.push({
            station_id: station.id,
            variant: variantLabel,
            attempt_count: group.length
          });
        }
        const groupN = group.length;
        const groupScores = scoreAttemptGroup(group, station, groupN);
        for (const [teamId, cell] of groupScores.entries()) {
          merged.set(teamId, cell);
        }
      }
      stationScoresByStation.set(station.id, merged);
    } else {
      const denominatorN =
        options.n_mode === "final" ? finalN : stAttempts.length;
      const scored = scoreAttemptGroup(stAttempts, station, denominatorN);
      stationScoresByStation.set(station.id, scored);
    }
  }

  const rows: LeaderboardRow[] = activeTeams.map((team) => {
    const stationCells: Record<number, StationTeamScore> = {};
    let grandTotal = 0;
    let firstPlaceCount = 0;
    let stationsPlayed = 0;

    for (const station of stations) {
      const cell = stationScoresByStation.get(station.id)?.get(team.id);
      if (cell) {
        stationCells[station.id] = cell;
        grandTotal += cell.total_points;
        stationsPlayed += 1;
        if (cell.rank === 1) {
          firstPlaceCount += 1;
        }
      } else {
        const fallbackN =
          options.n_mode === "final"
            ? finalN
            : (attemptsByStation.get(station.id)?.length ?? 0);
        stationCells[station.id] = {
          station_id: station.id,
          played: false,
          attempt_id: null,
          completed: null,
          time_ms: null,
          progress: null,
          variant: null,
          rank: null,
          n_used: fallbackN,
          game_points: 0,
          bonus_points: 0,
          total_points: 0
        };
      }
    }

    let hubElapsedMs: number | null = null;
    if (team.started_at !== null && team.finished_at !== null) {
      const diff =
        Date.parse(team.finished_at) - Date.parse(team.started_at);
      if (!Number.isNaN(diff) && diff >= 0) {
        hubElapsedMs = diff;
      }
    }

    return {
      overall_rank: 0,
      team_id: team.id,
      team_number: team.number,
      church: team.church,
      team_name: team.team_name,
      route_letter: routeToLetter(team.route),
      stations: stationCells,
      stations_played: stationsPlayed,
      first_place_count: firstPlaceCount,
      hub_elapsed_ms: hubElapsedMs,
      duel_won: team.duel_won,
      grand_total: round1(grandTotal),
      missing_finish_alert:
        stationsPlayed === stations.length && team.finished_at === null
    };
  });

  const compareRankOrder = (a: LeaderboardRow, b: LeaderboardRow): number => {
    if (a.grand_total !== b.grand_total) {
      return b.grand_total - a.grand_total;
    }
    if (a.first_place_count !== b.first_place_count) {
      return b.first_place_count - a.first_place_count;
    }
    const aElapsed = a.hub_elapsed_ms ?? Number.POSITIVE_INFINITY;
    const bElapsed = b.hub_elapsed_ms ?? Number.POSITIVE_INFINITY;
    if (aElapsed !== bElapsed) {
      return aElapsed - bElapsed;
    }
    if (a.duel_won !== b.duel_won) {
      return a.duel_won ? -1 : 1;
    }
    return 0;
  };

  rows.sort((a, b) => {
    const cmp = compareRankOrder(a, b);
    return cmp !== 0 ? cmp : a.team_number - b.team_number;
  });

  let rank = 1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i > 0 && compareRankOrder(rows[i - 1]!, row) !== 0) {
      rank = i + 1;
    }
    row.overall_rank = rank;
  }

  return {
    n_mode: options.n_mode,
    variant_ranking_mode: options.variant_ranking_mode,
    final_n: finalN,
    provisional: options.n_mode === "provisional",
    leaderboard: rows,
    variant_warnings: variantWarnings
  };
}
