/* global React, ReactDOM */
const { useState, useEffect, useMemo, useCallback, useRef, createContext, useContext } = React;

const LogoContext = createContext({});
function useLogo(teamId) {
  const map = useContext(LogoContext);
  return map[teamId] || null;
}

// ============================================================
// TEAM CONFIG
// ============================================================
const TEAMS = [
  {
    id: "padres", name: "Padres", city: "San Diego", sport: "MLB",
    leaguePath: "baseball/mlb", espnId: 25,
    primary: "#2F241D", secondary: "#FFC425", mono: "SD",
    division: "NL West",
  },
  {
    id: "chargers", name: "Chargers", city: "Los Angeles", sport: "NFL",
    leaguePath: "football/nfl", espnId: 24,
    primary: "#0080C6", secondary: "#FFC20E", mono: "LA",
    division: "AFC West",
  },
  {
    id: "orioles", name: "Orioles", city: "Baltimore", sport: "MLB",
    leaguePath: "baseball/mlb", espnId: 1,
    primary: "#DF4601", secondary: "#000000", mono: "BAL",
    division: "AL East",
  },
  {
    id: "ravens", name: "Ravens", city: "Baltimore", sport: "NFL",
    leaguePath: "football/nfl", espnId: 33,
    primary: "#241773", secondary: "#9E7C0C", mono: "BAL",
    division: "AFC North",
  },
  {
    id: "aztecs-mbb", name: "Aztecs MBB", city: "San Diego State", sport: "NCAA M-Hoops",
    leaguePath: "basketball/mens-college-basketball", espnId: 21,
    primary: "#A6192E", secondary: "#000000", mono: "SDSU",
    division: "Mountain West",
  },
  {
    id: "aztecs-fb", name: "Aztecs FB", city: "San Diego State", sport: "NCAA Football",
    leaguePath: "football/college-football", espnId: 21,
    primary: "#A6192E", secondary: "#000000", mono: "SDSU",
    division: "Mountain West",
  },
];

const REFRESH_MS = 60_000;
const BASE = "https://site.api.espn.com/apis/site/v2/sports";

// ============================================================
// API
// ============================================================
async function fetchJSON(url) {
  // Add a cache-buster so CDN edges don't return stale data on every poll
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}_=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchTeam(t) {
  // Returns { team: {...}, schedule: [...], news: [...] }
  const teamUrl = `${BASE}/${t.leaguePath}/teams/${t.espnId}`;
  const schedUrl = `${BASE}/${t.leaguePath}/teams/${t.espnId}/schedule`;
  const newsUrl = `${BASE}/${t.leaguePath}/news?team=${t.espnId}&limit=8`;

  const [teamRes, schedRes, newsRes] = await Promise.allSettled([
    fetchJSON(teamUrl),
    fetchJSON(schedUrl),
    fetchJSON(newsUrl),
  ]);

  const team = teamRes.status === "fulfilled" ? teamRes.value.team : null;
  const events = schedRes.status === "fulfilled" ? (schedRes.value.events || []) : [];
  const articles = newsRes.status === "fulfilled" ? (newsRes.value.articles || []) : [];

  return { team, events, articles };
}

async function fetchScoreboard(leaguePath) {
  // Scoreboard returns the current day's games with frequently-updated live scores
  try {
    const data = await fetchJSON(`${BASE}/${leaguePath}/scoreboard`);
    return data.events || [];
  } catch (e) {
    return [];
  }
}

function mergeEventsById(...lists) {
  // Later lists override earlier ones for the same event id (so scoreboard wins over schedule)
  const byId = new Map();
  for (const list of lists) {
    for (const ev of (list || [])) {
      if (ev && ev.id) byId.set(ev.id, ev);
    }
  }
  return Array.from(byId.values());
}

async function fetchSummary(leaguePath, eventId) {
  return fetchJSON(`${BASE}/${leaguePath}/summary?event=${eventId}`);
}

// Sport-specific top-performer categories we surface
const LEADER_CATEGORIES = {
  "baseball/mlb":                        ["hits", "homeRuns", "RBIs", "strikeouts", "wins"],
  "football/nfl":                        ["passingYards", "rushingYards", "receivingYards"],
  "football/college-football":           ["passingYards", "rushingYards", "receivingYards"],
  "basketball/mens-college-basketball":  ["points", "rebounds", "assists"],
};

// Team-level stat keys we look for in the boxscore (per sport)
const TEAM_STAT_KEYS = {
  "baseball/mlb":                        [["hits", "Hits"], ["runs", "Runs"], ["errors", "Errors"]],
  "football/nfl":                        [["totalYards", "Total Yds"], ["netPassingYards", "Pass Yds"], ["rushingYards", "Rush Yds"], ["turnovers", "Turnovers"]],
  "football/college-football":           [["totalYards", "Total Yds"], ["netPassingYards", "Pass Yds"], ["rushingYards", "Rush Yds"], ["turnovers", "Turnovers"]],
  "basketball/mens-college-basketball":  [["fieldGoalsMade-fieldGoalsAttempted", "FG"], ["threePointFieldGoalsMade-threePointFieldGoalsAttempted", "3PT"], ["rebounds", "REB"], ["assists", "AST"]],
};

function flattenStats(stats) {
  // boxscore.teams[i].statistics can be array OR object with sub-arrays (batting/pitching)
  if (!stats) return [];
  if (Array.isArray(stats)) return stats;
  const out = [];
  for (const k of Object.keys(stats)) {
    if (Array.isArray(stats[k])) out.push(...stats[k]);
  }
  return out;
}
function findStat(stats, key) {
  const flat = flattenStats(stats);
  const s = flat.find(x => x.name === key || x.abbreviation === key);
  return s?.displayValue ?? null;
}

async function fetchStandings(leaguePath) {
  // Try a couple endpoints; fall back gracefully
  const candidates = [
    `https://site.api.espn.com/apis/v2/sports/${leaguePath}/standings?group=division`,
    `https://site.api.espn.com/apis/v2/sports/${leaguePath}/standings`,
  ];
  for (const url of candidates) {
    try {
      const data = await fetchJSON(url);
      return data;
    } catch (e) { /* try next */ }
  }
  return null;
}

// ============================================================
// PARSERS / DERIVERS
// ============================================================
function parseRecord(team) {
  // ESPN team payload includes record.items[].summary like "23-22" or "10-5-1"
  if (!team || !team.record || !team.record.items) return null;
  const overall = team.record.items.find(i => i.type === "total") || team.record.items[0];
  return overall ? overall.summary : null;
}

function parseStandingLine(team) {
  if (!team) return null;
  // standingSummary like "2nd in NL West"
  return team.standingSummary || null;
}

function isCompleted(ev) {
  const s = ev?.competitions?.[0]?.status?.type || ev?.status?.type;
  return s?.completed === true || s?.state === "post";
}
function isInProgress(ev) {
  const s = ev?.competitions?.[0]?.status?.type || ev?.status?.type;
  return s?.state === "in";
}
function isScheduled(ev) {
  const s = ev?.competitions?.[0]?.status?.type || ev?.status?.type;
  return s?.state === "pre";
}

function pickCompetitors(ev, myEspnId) {
  const comp = ev?.competitions?.[0];
  if (!comp || !comp.competitors) return { me: null, opp: null, home: null, away: null };
  const me = comp.competitors.find(c => String(c.team?.id) === String(myEspnId));
  const opp = comp.competitors.find(c => String(c.team?.id) !== String(myEspnId));
  const home = comp.competitors.find(c => c.homeAway === "home");
  const away = comp.competitors.find(c => c.homeAway === "away");
  return { me, opp, home, away };
}

function deriveResult(ev, myEspnId) {
  // Returns 'W' | 'L' | 'T' | null
  if (!isCompleted(ev)) return null;
  const { me, opp } = pickCompetitors(ev, myEspnId);
  if (!me || !opp) return null;
  if (me.winner === true) return "W";
  if (opp.winner === true) return "L";
  const ms = Number(me.score?.value ?? me.score ?? 0);
  const os = Number(opp.score?.value ?? opp.score ?? 0);
  if (ms > os) return "W";
  if (ms < os) return "L";
  return "T";
}

function deriveStreak(events, myEspnId) {
  const completed = (events || [])
    .filter(isCompleted)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!completed.length) return null;
  let kind = null, count = 0;
  for (const ev of completed) {
    const r = deriveResult(ev, myEspnId);
    if (!r) continue;
    if (kind === null) { kind = r; count = 1; continue; }
    if (r === kind) count++;
    else break;
  }
  if (!kind) return null;
  return { kind, count };
}

function lastNResults(events, myEspnId, n = 5) {
  const completed = (events || [])
    .filter(isCompleted)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, n);
  return completed.map(ev => deriveResult(ev, myEspnId)).filter(Boolean);
}

function liveEvent(events) {
  return (events || []).find(isInProgress);
}
function lastCompletedEvent(events) {
  return (events || [])
    .filter(isCompleted)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
}
function nextScheduledEvent(events) {
  return (events || [])
    .filter(isScheduled)
    .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
}

function teamShortName(competitor) {
  return competitor?.team?.shortDisplayName || competitor?.team?.abbreviation || competitor?.team?.displayName || "—";
}

function fmtDate(iso, opts = {}) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", ...opts });
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ============================================================
// COMPONENTS
// ============================================================
function Monogram({ team, size = "", logoUrl }) {
  const ctxLogo = useLogo(team.id);
  const url = logoUrl || ctxLogo;
  const [imgFailed, setImgFailed] = useState(false);
  // Reset failure flag when URL changes (e.g. after a refetch)
  useEffect(() => { setImgFailed(false); }, [url]);
  const showImg = url && !imgFailed;
  return (
    <div
      className={`mono ${size} ${showImg ? "has-img" : ""}`}
      style={{
        "--mono-bg": showImg ? "#ffffff" : team.primary,
        "--mono-fg": team.secondary,
        "--mono-border": (!showImg && team.secondary === "#000000") ? team.secondary : "transparent",
      }}
      aria-hidden="true"
    >
      {showImg
        ? <img src={url} alt="" onError={() => setImgFailed(true)} />
        : <span>{team.mono}</span>}
    </div>
  );
}

function pickLogo(teamPayload) {
  if (!teamPayload || !teamPayload.logos || !teamPayload.logos.length) return null;
  // Prefer 'full' / 'default' / first
  const dark = teamPayload.logos.find(l => (l.rel || []).includes("default"));
  return (dark || teamPayload.logos[0]).href;
}

function TeamTile({ team, active, onClick, data }) {
  let statusEl = null;
  const live = liveEvent(data?.events);
  if (live) {
    statusEl = <span className="team-tile-status live">LIVE</span>;
  } else {
    const streak = deriveStreak(data?.events, team.espnId);
    if (streak) {
      const cls = streak.kind === "W" ? "win" : streak.kind === "L" ? "loss" : "";
      statusEl = <span className={`team-tile-status ${cls}`}>{streak.kind}{streak.count}</span>;
    }
  }
  return (
    <button
      className={`team-tile ${active ? "active" : ""}`}
      onClick={onClick}
      style={{ "--accent": team.primary === "#000000" ? team.secondary : team.primary }}
    >
      <Monogram team={team} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="team-tile-name">{team.name}</div>
        <div className="team-tile-sub">{team.city}</div>
      </div>
      {statusEl}
    </button>
  );
}

function StreakPips({ results }) {
  if (!results || !results.length) {
    return <div className="streak-pips">{[0,1,2,3,4].map(i => <span key={i} className="pip" />)}</div>;
  }
  return (
    <div className="streak-pips">
      {results.slice().reverse().map((r, i) => <span key={i} className={`pip ${r}`} title={r} />)}
    </div>
  );
}

function ScoreCard({ team, data, onClick }) {
  const accent = team.primary === "#000000" ? team.secondary : team.primary;
  if (!data) {
    return (
      <div className="card score-card" onClick={onClick} style={{ "--accent": accent }}>
        <div className="score-card-stripe" />
        <div className="score-card-body">
          <div className="score-card-head">
            <Monogram team={team} size="lg" />
            <div className="score-card-head-text">
              <div className="score-card-team-name">{team.name}</div>
              <div className="score-card-league">{team.sport}</div>
            </div>
          </div>
          <div className="skel skel-line big" style={{ margin: "12px 0" }} />
          <div className="skel skel-line" />
          <div className="skel skel-line" />
        </div>
      </div>
    );
  }

  const live = liveEvent(data.events);
  const last = lastCompletedEvent(data.events);
  const next = nextScheduledEvent(data.events);
  const featured = live || last || next;

  const streak = deriveStreak(data.events, team.espnId);
  const record = parseRecord(data.team);
  const standing = parseStandingLine(data.team);
  const last5 = lastNResults(data.events, team.espnId, 5);

  return (
    <div className="card score-card" onClick={onClick} style={{ "--accent": accent }}>
      <div className="score-card-stripe" />
      <div className="score-card-body">
        <div className="score-card-head">
          <Monogram team={team} size="lg" />
          <div className="score-card-head-text">
            <div className="score-card-team-name">{team.name}</div>
            <div className="score-card-league">{team.sport} · {team.division}</div>
          </div>
          {live && <span className="score-card-status live">LIVE</span>}
          {!live && featured && isCompleted(featured) && <span className="score-card-status final">FINAL</span>}
          {!live && featured && isScheduled(featured) && <span className="score-card-status scheduled">UPCOMING</span>}
          {!featured && <span className="score-card-status scheduled">—</span>}
        </div>

        <FeaturedGame ev={featured} team={team} />

        <div className="score-card-stats">
          <div className="stat">
            <div className="stat-label">Record</div>
            <div className="stat-value">{record || "—"}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Streak</div>
            <div className={`stat-value ${streak ? (streak.kind === "W" ? "win" : streak.kind === "L" ? "loss" : "") : ""}`}>
              {streak ? `${streak.kind}${streak.count}` : "—"}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Last 5</div>
            <StreakPips results={last5} />
          </div>
        </div>

        {standing && (
          <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: 0.4, marginTop: 12, textAlign: "center", textTransform: "uppercase" }}>
            {standing}
          </div>
        )}
      </div>
    </div>
  );
}

function FeaturedGame({ ev, team }) {
  if (!ev) {
    return (
      <div className="upcoming">
        <div className="upcoming-time">No game scheduled</div>
        <div className="upcoming-date">Check back soon</div>
      </div>
    );
  }
  const { me, opp, home, away } = pickCompetitors(ev, team.espnId);
  const status = ev?.competitions?.[0]?.status?.type || ev?.status?.type;
  const live = status?.state === "in";
  const completed = status?.completed;

  if (live || completed) {
    const homeScore = home?.score?.value ?? home?.score ?? "—";
    const awayScore = away?.score?.value ?? away?.score ?? "—";
    const myScore = Number(me?.score?.value ?? me?.score ?? 0);
    const oppScore = Number(opp?.score?.value ?? opp?.score ?? 0);
    const winning = myScore > oppScore;
    return (
      <div className="matchup">
        <div className="matchup-side">
          <Monogram team={team} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="matchup-name">{team.name}</div>
            <div className="matchup-score" style={{ color: winning ? "white" : "var(--ink-2)" }}>
              {myScore}
            </div>
          </div>
        </div>
        <div className="matchup-mid">
          <div style={{ fontWeight: 700, color: live ? "var(--live)" : "var(--ink-3)" }}>
            {live ? (status.shortDetail || "LIVE") : "FINAL"}
          </div>
          <div style={{ marginTop: 4 }}>{me?.homeAway === "home" ? "vs" : "@"}</div>
        </div>
        <div className="matchup-side right">
          <div style={{ textAlign: "right", minWidth: 0 }}>
            <div className="matchup-name">{teamShortName(opp)}</div>
            <div className="matchup-score" style={{ color: !winning ? "white" : "var(--ink-2)" }}>
              {oppScore}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Scheduled
  return (
    <div className="upcoming">
      <div className="upcoming-time">{fmtTime(ev.date)}</div>
      <div className="upcoming-date">{fmtDate(ev.date, { weekday: "short" })}</div>
      <div className="upcoming-opp">
        {me?.homeAway === "home" ? "vs " : "@ "}{teamShortName(opp)}
      </div>
    </div>
  );
}

// ============================================================
// DETAIL VIEW
// ============================================================
function DetailView({ team, data, onOpenGame }) {
  if (!data) return <div className="empty">Loading {team.name}…</div>;

  const record = parseRecord(data.team);
  const standing = parseStandingLine(data.team);
  const streak = deriveStreak(data.events, team.espnId);
  const live = liveEvent(data.events);
  const last = lastCompletedEvent(data.events);
  const next = nextScheduledEvent(data.events);
  const featured = live || next || last;
  const last5 = lastNResults(data.events, team.espnId, 5);

  const accent = team.primary === "#000000" ? team.secondary : team.primary;
  const accent2 = team.secondary && team.secondary !== "#000000" ? team.secondary : team.primary;

  return (
    <div style={{ "--accent": accent, "--accent-2": accent2 }}>
      <div className="detail-hero">
        <div className="detail-hero-row">
          <Monogram team={team} size="xl" />
          <div className="detail-hero-text">
            <h2 className="detail-hero-name">{team.city} {team.name}</h2>
            <div className="detail-hero-meta">{team.sport} · {standing || team.division}</div>
          </div>
          <div className="detail-hero-stats">
            <div>
              <div className="detail-hero-stat-label">Record</div>
              <div className="detail-hero-stat-value">{record || "—"}</div>
            </div>
            <div>
              <div className="detail-hero-stat-label">Streak</div>
              <div className="detail-hero-stat-value">{streak ? `${streak.kind}${streak.count}` : "—"}</div>
            </div>
            <div>
              <div className="detail-hero-stat-label">Last 5</div>
              <div style={{ marginTop: 8 }}>
                <StreakPips results={last5} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {featured && (
        <div className="card card-clickable clickable" style={{ marginBottom: 14 }} onClick={() => onOpenGame && onOpenGame(featured, team)}>
          <div className="card-header">
            <h3 className="card-title">{live ? "Live Now" : (isCompleted(featured) ? "Most Recent" : "Up Next")}</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {live && <span className="score-card-status live">LIVE</span>}
              {(isCompleted(featured) || live) && <span style={{ fontSize: 10, letterSpacing: 1.2, color: "var(--ink-3)", textTransform: "uppercase" }}>Tap for stats →</span>}
            </div>
          </div>
          <BigMatchup ev={featured} team={team} />
        </div>
      )}

      <div className="two-col">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Recent Games</h3>
          </div>
          <EventList events={data.events} team={team} mode="past" onOpenGame={onOpenGame} />
        </div>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Upcoming</h3>
          </div>
          <EventList events={data.events} team={team} mode="future" onOpenGame={onOpenGame} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-header">
          <h3 className="card-title">News & Stories</h3>
        </div>
        <NewsList articles={data.articles} />
      </div>
    </div>
  );
}

function BigMatchup({ ev, team }) {
  const { me, opp } = pickCompetitors(ev, team.espnId);
  const status = ev?.competitions?.[0]?.status?.type || ev?.status?.type;
  const live = status?.state === "in";
  const completed = status?.completed;
  const myScore = me?.score?.value ?? me?.score;
  const oppScore = opp?.score?.value ?? opp?.score;

  return (
    <div style={{ padding: "8px 4px" }}>
      <div className="matchup" style={{ paddingBottom: 14 }}>
        <div className="matchup-side">
          <Monogram team={team} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div className="matchup-name" style={{ fontSize: 15 }}>{team.name}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              {me?.homeAway === "home" ? "HOME" : "AWAY"}
            </div>
          </div>
        </div>
        {(live || completed) ? (
          <div style={{ textAlign: "center" }}>
            <div className="matchup-score" style={{ fontSize: 48 }}>
              {myScore ?? "—"}
              <span style={{ opacity: 0.4, padding: "0 14px", fontSize: 28 }}>·</span>
              {oppScore ?? "—"}
            </div>
            <div style={{ fontSize: 11, color: live ? "var(--live)" : "var(--ink-3)", marginTop: 6, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: 700 }}>
              {live ? (status.shortDetail || "Live") : "Final"}
            </div>
          </div>
        ) : (
          <div style={{ textAlign: "center" }}>
            <div className="upcoming-time" style={{ fontSize: 26 }}>{fmtTime(ev.date)}</div>
            <div className="upcoming-date">{fmtDate(ev.date, { weekday: "short", year: "numeric" })}</div>
          </div>
        )}
        <div className="matchup-side right">
          <div style={{ textAlign: "right", minWidth: 0 }}>
            <div className="matchup-name" style={{ fontSize: 15 }}>{teamShortName(opp)}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              {opp?.homeAway === "home" ? "HOME" : "AWAY"}
            </div>
          </div>
        </div>
      </div>
      {ev?.competitions?.[0]?.venue?.fullName && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", textAlign: "center", letterSpacing: 0.8, textTransform: "uppercase" }}>
          {ev.competitions[0].venue.fullName}
        </div>
      )}
    </div>
  );
}

function EventList({ events, team, mode, onOpenGame }) {
  const rows = useMemo(() => {
    const filtered = (events || []).filter(mode === "past" ? isCompleted : isScheduled);
    filtered.sort((a, b) => mode === "past" ? new Date(b.date) - new Date(a.date) : new Date(a.date) - new Date(b.date));
    return filtered.slice(0, 6);
  }, [events, mode]);

  if (!rows.length) return <div className="empty">{mode === "past" ? "No recent games." : "No games scheduled."}</div>;

  return (
    <div className="event-list">
      {rows.map(ev => {
        const { me, opp } = pickCompetitors(ev, team.espnId);
        const result = mode === "past" ? deriveResult(ev, team.espnId) : null;
        const myScore = me?.score?.value ?? me?.score;
        const oppScore = opp?.score?.value ?? opp?.score;
        const d = new Date(ev.date);
        const dayLabel = d.toLocaleString(undefined, { day: "numeric" });
        const monthLabel = d.toLocaleString(undefined, { month: "short" });
        return (
          <div
            key={ev.id}
            className={`event-row ${mode === "past" && onOpenGame ? "clickable" : ""}`}
            onClick={mode === "past" && onOpenGame ? () => onOpenGame(ev, team) : undefined}
          >
            <div className="event-date">
              <div className="event-date-day">{dayLabel}</div>
              <div>{monthLabel}</div>
            </div>
            <div>
              <div className="event-opp">{me?.homeAway === "home" ? "vs " : "@ "}{teamShortName(opp)}</div>
              <div className="event-opp-sub">
                {mode === "future"
                  ? fmtTime(ev.date)
                  : (ev.competitions?.[0]?.venue?.fullName || "")}
              </div>
            </div>
            <div>
              {result ? (
                <div className={`event-result ${result}`}>
                  <span className={`event-result-tag ${result}`}>{result}</span>
                  {myScore}–{oppScore}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "right" }}>
                  {fmtDate(ev.date, { weekday: "short" })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NewsList({ articles }) {
  if (!articles || !articles.length) return <div className="empty">No recent stories.</div>;
  return (
    <div className="news-list">
      {articles.slice(0, 6).map((a, i) => {
        const img = a.images?.[0]?.url;
        const href = a.links?.web?.href || a.links?.api?.news?.href;
        const date = a.published || a.lastModified;
        return (
          <a key={a.id || i} className="news-item" href={href} target="_blank" rel="noreferrer">
            <div className={`news-thumb ${img ? "" : "placeholder"}`} style={img ? { backgroundImage: `url(${img})` } : {}} />
            <div className="news-body">
              <div className="news-headline">{a.headline || a.title}</div>
              <div className="news-meta">
                {a.byline ? `${a.byline} · ` : ""}
                {date ? new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

// ============================================================
// GAME STATS MODAL — opens when a user clicks a specific game
// ============================================================
function GameStatsModal({ ev, team, onClose }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const live = isInProgress(ev);

  // Initial + refresh fetch
  useEffect(() => {
    let cancelled = false;
    let intervalId = null;

    async function load() {
      try {
        const data = await fetchSummary(team.leaguePath, ev.id);
        if (!cancelled) { setSummary(data); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    if (live) intervalId = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId); };
  }, [ev.id, team.leaguePath, live]);

  // Close on Escape, lock body scroll while open
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handler);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const accent = team.primary === "#000000" ? team.secondary : team.primary;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ "--accent": accent }}>
        <button className="modal-close" onClick={onClose} aria-label="Close stats">×</button>
        {summary
          ? <GameStatsContent summary={summary} ev={ev} team={team} />
          : (
            <>
              <GameStatsHero ev={ev} team={team} summary={null} />
              <div className="gs-body">
                {loading && <div className="empty">Loading stats…</div>}
                {error && !loading && <div className="error-bar">Couldn't load game details.</div>}
              </div>
            </>
          )}
      </div>
    </div>
  );
}

function GameStatsHero({ ev, team, summary }) {
  const comp = summary?.header?.competitions?.[0] || ev?.competitions?.[0];
  const status = comp?.status?.type || ev?.status?.type;
  const live = status?.state === "in";
  const completed = status?.completed;
  const competitors = comp?.competitors || [];
  const homeC = competitors.find(c => c.homeAway === "home");
  const awayC = competitors.find(c => c.homeAway === "away");

  const sideTeam = (c) => {
    if (!c) return null;
    const known = TEAMS.find(t => String(t.espnId) === String(c.team?.id));
    if (known) return known;
    return {
      id: `_${c.team?.id}`,
      mono: c.team?.abbreviation || "?",
      name: c.team?.shortDisplayName || c.team?.displayName || "—",
      primary: c.team?.color ? `#${c.team.color}` : "#333",
      secondary: c.team?.alternateColor ? `#${c.team.alternateColor}` : "#fff",
    };
  };
  const aT = sideTeam(awayC);
  const hT = sideTeam(homeC);
  const aScore = awayC?.score?.value ?? awayC?.score ?? (live || completed ? "0" : null);
  const hScore = homeC?.score?.value ?? homeC?.score ?? (live || completed ? "0" : null);

  return (
    <div className="gs-hero">
      <div className="gs-hero-row">
        <div className="gs-hero-side">
          {aT && <Monogram team={aT} size="lg" logoUrl={awayC?.team?.logo} />}
          <div style={{ minWidth: 0 }}>
            <div className="gs-hero-name">{aT?.name || "Away"}</div>
            <div className="gs-hero-sub">{awayC?.records?.[0]?.summary || "Away"}</div>
          </div>
        </div>
        <div className="gs-hero-mid">
          <div className={`gs-status-pill ${live ? "live" : ""}`}>
            {live ? "LIVE" : completed ? "FINAL" : "SCHEDULED"}
          </div>
          {(live || completed) ? (
            <div className="gs-hero-score" style={{ marginTop: 6 }}>
              {aScore}
              <span style={{ opacity: 0.4, padding: "0 14px", fontSize: 26 }}>·</span>
              {hScore}
            </div>
          ) : (
            <div className="gs-hero-score" style={{ fontSize: 24, marginTop: 6 }}>
              {fmtTime(ev.date)}
            </div>
          )}
          <div style={{ marginTop: 6 }}>{status?.shortDetail || status?.detail || fmtDate(ev.date)}</div>
        </div>
        <div className="gs-hero-side right">
          <div style={{ minWidth: 0, textAlign: "right" }}>
            <div className="gs-hero-name">{hT?.name || "Home"}</div>
            <div className="gs-hero-sub">{homeC?.records?.[0]?.summary || "Home"}</div>
          </div>
          {hT && <Monogram team={hT} size="lg" logoUrl={homeC?.team?.logo} />}
        </div>
      </div>
      {comp?.venue?.fullName && (
        <div className="gs-venue">{comp.venue.fullName}{comp.venue.address?.city ? ` · ${comp.venue.address.city}${comp.venue.address.state ? `, ${comp.venue.address.state}` : ""}` : ""}</div>
      )}
    </div>
  );
}

function GameStatsContent({ summary, ev, team }) {
  const comp = summary?.header?.competitions?.[0] || ev?.competitions?.[0];
  const competitors = comp?.competitors || [];
  const homeC = competitors.find(c => c.homeAway === "home");
  const awayC = competitors.find(c => c.homeAway === "away");

  const bsTeams = summary?.boxscore?.teams || [];
  const findBs = (id) => bsTeams.find(bt => String(bt.team?.id) === String(id));
  const aBs = findBs(awayC?.team?.id);
  const hBs = findBs(homeC?.team?.id);

  const leadersList = summary?.leaders || [];
  const findLeaders = (id) => leadersList.find(l => String(l.team?.id) === String(id));
  const aLeaders = findLeaders(awayC?.team?.id);
  const hLeaders = findLeaders(homeC?.team?.id);

  const statKeys = TEAM_STAT_KEYS[team.leaguePath] || [];
  const leaderCats = LEADER_CATEGORIES[team.leaguePath] || [];

  const hasStats = statKeys.length > 0 && (aBs || hBs);
  const hasLeaders = (aLeaders?.leaders?.length || hLeaders?.leaders?.length);

  return (
    <>
      <GameStatsHero ev={ev} team={team} summary={summary} />
      <div className="gs-body">
        {!hasStats && !hasLeaders && (
          <div className="empty">Detailed stats aren't published yet for this game.</div>
        )}

        {hasStats && (
          <div className="gs-section">
            <div className="gs-section-label">Team Stats</div>
            <div className="gs-stats-table">
              <div className="gs-stats-table-head">
                <div className="gs-cell left">{awayC?.team?.shortDisplayName || "Away"}</div>
                <div className="gs-cell">Stat</div>
                <div className="gs-cell right">{homeC?.team?.shortDisplayName || "Home"}</div>
              </div>
              {statKeys.map(([key, label]) => {
                const aV = findStat(aBs?.statistics, key);
                const hV = findStat(hBs?.statistics, key);
                if (aV == null && hV == null) return null;
                return (
                  <div key={key} className="gs-stats-row">
                    <div className="gs-cell left">{aV ?? "—"}</div>
                    <div className="gs-cell label">{label}</div>
                    <div className="gs-cell right">{hV ?? "—"}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {hasLeaders && (
          <div className="gs-section">
            <div className="gs-section-label">Top Performers</div>
            <div className="gs-leaders-grid">
              <LeaderColumn teamLabel={awayC?.team?.shortDisplayName || "Away"} leadersBlock={aLeaders} categories={leaderCats} />
              <LeaderColumn teamLabel={homeC?.team?.shortDisplayName || "Home"} leadersBlock={hLeaders} categories={leaderCats} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function LeaderColumn({ teamLabel, leadersBlock, categories }) {
  const all = leadersBlock?.leaders || [];
  // Prefer ordered categories, then fall back to any extras
  const ordered = [];
  for (const cat of categories) {
    const f = all.find(x => x.name === cat);
    if (f && f.leaders?.length) ordered.push(f);
  }
  if (!ordered.length) {
    for (const f of all.slice(0, 3)) if (f.leaders?.length) ordered.push(f);
  }
  return (
    <div className="gs-leader-col">
      <div className="gs-leader-team">{teamLabel}</div>
      {ordered.length === 0 ? (
        <div className="empty" style={{ padding: "8px 0" }}>—</div>
      ) : ordered.map(cat => {
        const top = cat.leaders[0];
        return (
          <div key={cat.name} className="gs-leader-row">
            <div className="gs-leader-cat">{cat.shortDisplayName || cat.displayName || cat.name}</div>
            <div className="gs-leader-athlete">{top.athlete?.shortName || top.athlete?.displayName}</div>
            <div className="gs-leader-val">{top.displayValue}</div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
function App() {
  const [selected, setSelected] = useState("all");
  const [dataByTeam, setDataByTeam] = useState({});
  const [status, setStatus] = useState("loading"); // 'loading' | 'ok' | 'error'
  const [lastUpdated, setLastUpdated] = useState(null);
  const [tick, setTick] = useState(0); // forces "last updated X ago" rerender
  const [errMsg, setErrMsg] = useState(null);
  const [gameModal, setGameModal] = useState(null); // { ev, team } | null
  const inFlight = useRef(false);

  const loadAll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus(prev => prev === "ok" ? "loading" : prev);
    setErrMsg(null);
    try {
      // Fetch the league-wide scoreboard once per unique league — this is where
      // live in-game scores update frequently. Then merge into each team's
      // schedule so live events have the freshest score data.
      const leaguePaths = Array.from(new Set(TEAMS.map(t => t.leaguePath)));
      const sbList = await Promise.all(leaguePaths.map(lp => fetchScoreboard(lp)));
      const sbByLeague = {};
      leaguePaths.forEach((lp, i) => { sbByLeague[lp] = sbList[i] || []; });

      const entries = await Promise.all(
        TEAMS.map(async t => {
          try {
            const d = await fetchTeam(t);
            // Filter scoreboard events to ones containing this team
            const teamSbEvents = (sbByLeague[t.leaguePath] || []).filter(ev =>
              ev?.competitions?.[0]?.competitors?.some(c => String(c.team?.id) === String(t.espnId))
            );
            // Scoreboard events override schedule events with the same id
            d.events = mergeEventsById(d.events, teamSbEvents);
            return [t.id, d];
          } catch (e) {
            return [t.id, null];
          }
        })
      );
      const next = {};
      let anyOk = false;
      for (const [id, d] of entries) {
        next[id] = d;
        if (d && d.team) anyOk = true;
      }
      setDataByTeam(next);
      setLastUpdated(new Date());
      setStatus(anyOk ? "ok" : "error");
      if (!anyOk) setErrMsg("Couldn't reach the live sports feed. Will try again in 60s.");
    } catch (e) {
      setStatus("error");
      setErrMsg(String(e?.message || e));
    } finally {
      inFlight.current = false;
    }
  }, []);

  // initial + 60s tick
  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadAll]);

  // 10s 'time-ago' rerender so the timestamp stays fresh between fetches
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  const timeAgo = useMemo(() => {
    if (!lastUpdated) return "—";
    const s = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return `${m}m ago`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUpdated, tick]);

  const selectedTeam = TEAMS.find(t => t.id === selected);

  const logoMap = useMemo(() => {
    const m = {};
    for (const t of TEAMS) {
      const url = pickLogo(dataByTeam[t.id]?.team);
      if (url) m[t.id] = url;
    }
    return m;
  }, [dataByTeam]);

  return (
    <LogoContext.Provider value={logoMap}>
    <div className="app">
      <aside className="rail">
        <div className="rail-brand">
          <div className="rail-brand-mark">BB</div>
          <div>
            <div className="rail-brand-title">The Big Board</div>
            <div className="rail-brand-sub">Our family scoreboard</div>
          </div>
        </div>

        <div className="rail-section-label">Overview</div>
        <button
          className={`team-tile ${selected === "all" ? "active" : ""}`}
          onClick={() => setSelected("all")}
          style={{ "--accent": "#3ecf8e" }}
        >
          <div className="mono" style={{ background: "linear-gradient(135deg, #ff8e3c, #ff3b5c 60%, #6a3bff)", color: "white" }}>
            <span style={{ fontSize: 14 }}>ALL</span>
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="team-tile-name">All Teams</div>
            <div className="team-tile-sub">Big board</div>
          </div>
        </button>

        <div className="rail-section-label">Our Teams</div>
        {TEAMS.map(t => (
          <TeamTile
            key={t.id}
            team={t}
            active={selected === t.id}
            onClick={() => setSelected(t.id)}
            data={dataByTeam[t.id]}
          />
        ))}
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{selected === "all" ? "The Big Board" : `The Big Board · ${selectedTeam.name}`}</h1>
          <div className="topbar-meta">
            <span className={`refresh-dot ${status === "loading" ? "loading" : status === "error" ? "error" : ""}`} />
            <span>Updated {timeAgo}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>auto-refresh 60s</span>
            <button className="refresh-btn" onClick={loadAll} disabled={status === "loading"}>
              {status === "loading" ? "Refreshing…" : "Refresh now"}
            </button>
          </div>
        </div>

        {errMsg && <div className="error-bar">{errMsg}</div>}

        {selected === "all" ? (
          <div className="grid">
            {TEAMS.map(t => (
              <ScoreCard key={t.id} team={t} data={dataByTeam[t.id]} onClick={() => setSelected(t.id)} />
            ))}
          </div>
        ) : (
          <DetailView
            team={selectedTeam}
            data={dataByTeam[selected]}
            onOpenGame={(ev, t) => setGameModal({ ev, team: t })}
          />
        )}
      </main>
      {gameModal && (
        <GameStatsModal
          ev={gameModal.ev}
          team={gameModal.team}
          onClose={() => setGameModal(null)}
        />
      )}
    </div>
    </LogoContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
