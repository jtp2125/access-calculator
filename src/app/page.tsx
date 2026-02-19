"use client";

import React, { useState, useMemo, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// ── CONFIG ───────────────────────────────────────────────────────────────────
const RATES = {
  eCKM: { monthly: { initial: 24.0, followOn: 12.0 } },
  CKM: { monthly: { initial: 28.0, followOn: 14.0 } },
  MSK: { monthly: { initial: 12.0, followOn: null }, noFollowOn: true },
  BH: { monthly: { initial: 12.0, followOn: 6.0 } },
} as const;

const TRACKS = ["eCKM", "CKM", "MSK", "BH"] as const;
type Track = (typeof TRACKS)[number];

const TRACK_COLORS: Record<Track, string> = {
  eCKM: "#3b82f6",
  CKM: "#8b5cf6",
  MSK: "#22c55e",
  BH: "#f97316",
};

const RURAL_MEDICARE = 12;
const ADJ = { oatM1to18: 0.5, sst: 0.9, coaCap: 0.5, ssaCap: 0.25 } as const;
const RECON_MONTHS = [6, 12, 18, 24, 30, 36] as const;
const COHORT_YEAR: Record<1 | 2 | 3, "Y1" | "Y2" | "Y3"> = {
  1: "Y1",
  2: "Y2",
  3: "Y3",
};

const DEFAULTS = {
  totalPanel: 182774,
  eligible: { eCKM: 89703, CKM: 107862, MSK: 69416, BH: 83044 },
  growthY2: 0.4,
  growthY3: 0.4,
  penetrationMode: "uniform" as "uniform" | "perTrack",
  penetrationUniform: 0.25,
  penetrationByTrack: { eCKM: 0.25, CKM: 0.25, MSK: 0.25, BH: 0.25 },
  rampPeriod: 12,
  controlGroupByYear: { Y1: true, Y2: false, Y3: false },
  churnRate: 0.2,
  overlapRate: 0.05,
  costSharingWaived: true,
  ruralPct: 0.15,
  pearlShare: 0.2,
  oar: { eCKM: 0.55, CKM: 0.55, MSK: 0.5, BH: 0.5 },
  oatM19to36: 0.625,
  ssr: { eCKM: 0.92, CKM: 0.92, MSK: 0.9, BH: 0.92 },
};

type Inputs = typeof DEFAULTS;

const SECTION_KEYS = {
  panel: ["totalPanel", "eligible", "growthY2", "growthY3"],
  enrollment: [
    "penetrationMode",
    "penetrationUniform",
    "penetrationByTrack",
    "rampPeriod",
    "controlGroupByYear",
  ],
  flow: ["churnRate", "overlapRate"],
  financial: ["costSharingWaived", "ruralPct", "pearlShare"],
  performance: ["oar", "oatM19to36", "ssr"],
} as const;

// ── ENGINE ───────────────────────────────────────────────────────────────────
type SubCohort = {
  track: Track;
  mc: 1 | 2 | 3;
  enrollM: number;
  inc: number;
};

type MonthlyRow = {
  T: number;
  byTrack: Record<
    Track,
    { initial: number; followOn: number; paid: number; withheld: number; rural: number }
  >;
  byCohort: Record<1 | 2 | 3, number>;
  grossRev: number;
  paidRev: number;
  withheldRev: number;
  ruralRev: number;
  discount: number;
  totalEnrolled: number;
};

type FullRow = MonthlyRow & {
  isRecon: boolean;
  netPaid: number;
  release: number;
  netRev: number;
  pearlRev: number;
  blendAdj: number;
  pearlCumul: number;
  newlyEnrolledTotal: number;
  churnedTotal: number;
  netChange: number;
  initialPeriodEnrolled: number;
  followOnEnrolled: number;
  c1NewlyEnrolled: number;
  c2NewlyEnrolled: number;
  c3NewlyEnrolled: number;
};

function runModel(inp: Inputs, activeTracks: Track[]) {
  const tracks: Track[] = activeTracks.length > 0 ? activeTracks : [...TRACKS];

  // Step 1: panel growth
  const prop: Record<Track, number> = { eCKM: 0, CKM: 0, MSK: 0, BH: 0 };
  TRACKS.forEach((t) => {
    prop[t] = inp.eligible[t] / inp.totalPanel;
  });

  const newPanelY2 = inp.totalPanel * inp.growthY2;
  const newPanelY3 = inp.totalPanel * (1 + inp.growthY2) * inp.growthY3;

  const newEligY2: Record<Track, number> = { eCKM: 0, CKM: 0, MSK: 0, BH: 0 };
  const newEligY3: Record<Track, number> = { eCKM: 0, CKM: 0, MSK: 0, BH: 0 };

  TRACKS.forEach((t) => {
    newEligY2[t] = newPanelY2 * prop[t];
    newEligY3[t] = newPanelY3 * prop[t];
  });

  const eligByYear: Record<"Y1" | "Y2" | "Y3", Record<Track, number>> = {
    Y1: { ...inp.eligible },
    Y2: { eCKM: 0, CKM: 0, MSK: 0, BH: 0 },
    Y3: { eCKM: 0, CKM: 0, MSK: 0, BH: 0 },
  };

  TRACKS.forEach((t) => {
    eligByYear.Y2[t] = eligByYear.Y1[t] + newEligY2[t];
    eligByYear.Y3[t] = eligByYear.Y2[t] + newEligY3[t];
  });

  // Step 2: build sub-cohorts
  const cohortDefs: Array<{ mc: 1 | 2 | 3; start: number; targetBase: Record<Track, number> }> = [
    { mc: 1, start: 1, targetBase: eligByYear.Y1 },
    { mc: 2, start: 13, targetBase: newEligY2 },
    { mc: 3, start: 25, targetBase: newEligY3 },
  ];

  const subCohorts: SubCohort[] = [];
  cohortDefs.forEach((cd) => {
    const rampEnd = Math.min(cd.start + inp.rampPeriod - 1, 36);
    const ctrlAdj = inp.controlGroupByYear[COHORT_YEAR[cd.mc]] ? 0.9 : 1.0;

    tracks.forEach((t) => {
      const pen = inp.penetrationMode === "uniform" ? inp.penetrationUniform : inp.penetrationByTrack[t];
      const target = cd.targetBase[t] * pen * ctrlAdj;

      for (let m = cd.start; m <= rampEnd; m++) {
        const inc = target / inp.rampPeriod;
        if (inc > 0) subCohorts.push({ track: t, mc: cd.mc, enrollM: m, inc });
      }
    });
  });

  // Step 3-5: monthly loop
  const monthlyChurn = inp.churnRate / 12;
  const rateMultiplier = inp.costSharingWaived ? 1.0 : 1.25;
  const rawMonths: MonthlyRow[] = [];
  const monthlyNewEnrollments: Record<number, { total: number; byCohort: Record<1 | 2 | 3, number> }> = {};

  for (let T = 1; T <= 36; T++) {
    monthlyNewEnrollments[T] = { total: 0, byCohort: { 1: 0, 2: 0, 3: 0 } };
  }

  subCohorts.forEach((sc) => {
    monthlyNewEnrollments[sc.enrollM].total += sc.inc;
    monthlyNewEnrollments[sc.enrollM].byCohort[sc.mc] += sc.inc;
  });

  for (let T = 1; T <= 36; T++) {
    const byTrack: MonthlyRow["byTrack"] = {
      eCKM: { initial: 0, followOn: 0, paid: 0, withheld: 0, rural: 0 },
      CKM: { initial: 0, followOn: 0, paid: 0, withheld: 0, rural: 0 },
      MSK: { initial: 0, followOn: 0, paid: 0, withheld: 0, rural: 0 },
      BH: { initial: 0, followOn: 0, paid: 0, withheld: 0, rural: 0 },
    };

    const byCohort: MonthlyRow["byCohort"] = { 1: 0, 2: 0, 3: 0 };

    subCohorts.forEach((sc) => {
      if (T < sc.enrollM) return;
      const age = T - sc.enrollM + 1;
      const cpMonth = ((age - 1) % 12) + 1;

      const isInitial = (RATES as any)[sc.track].noFollowOn || age <= 12;
      const isPaid = cpMonth <= 6;
      const live = sc.inc * Math.pow(1 - monthlyChurn, age - 1);

      const rate =
        ((RATES as any)[sc.track].monthly[isInitial ? "initial" : "followOn"] as number) * rateMultiplier;

      const rev = live * rate;

      byTrack[sc.track][isInitial ? "initial" : "followOn"] += live;
      if (isPaid) byTrack[sc.track].paid += rev;
      else byTrack[sc.track].withheld += rev;

      if (T === sc.enrollM && (sc.track === "eCKM" || sc.track === "CKM")) {
        byTrack[sc.track].rural += sc.inc * inp.ruralPct * RURAL_MEDICARE;
      }

      byCohort[sc.mc] += live;
    });

    const totalEnrolled = tracks.reduce((s, t) => s + byTrack[t].initial + byTrack[t].followOn, 0);
    const overlapPts = totalEnrolled * inp.overlapRate;

    const bhI = byTrack.BH.initial,
      bhF = byTrack.BH.followOn,
      bhTot = bhI + bhF;

    const bhRate =
      bhTot === 0
        ? ((RATES as any).BH.monthly.initial as number) * rateMultiplier
        : ((bhI * (RATES as any).BH.monthly.initial +
            bhF * (((RATES as any).BH.monthly.followOn as number) || 0)) /
            bhTot) *
          rateMultiplier;

    const discount = tracks.length > 1 ? overlapPts * bhRate * 0.05 : 0;

    let grossRev = 0,
      paidRev = 0,
      withheldRev = 0,
      ruralRev = 0;

    tracks.forEach((t) => {
      grossRev += byTrack[t].paid + byTrack[t].withheld;
      paidRev += byTrack[t].paid;
      withheldRev += byTrack[t].withheld;
      ruralRev += byTrack[t].rural;
    });

    grossRev = Math.max(0, grossRev - discount + ruralRev);
    paidRev = Math.max(0, paidRev - discount);

    rawMonths.push({
      T,
      byTrack,
      byCohort,
      grossRev,
      paidRev,
      withheldRev,
      ruralRev,
      discount,
      totalEnrolled,
    });
  }

  // Step 6: adjustments
  const completionRate = 1 - inp.churnRate;

  const effOAR: Record<Track, number> = { eCKM: 0, CKM: 0, MSK: 0, BH: 0 };
  const coa: Record<Track, { early: number; late: number }> = {
    eCKM: { early: 0, late: 0 },
    CKM: { early: 0, late: 0 },
    MSK: { early: 0, late: 0 },
    BH: { early: 0, late: 0 },
  };
  const ssa: Record<Track, number> = { eCKM: 0, CKM: 0, MSK: 0, BH: 0 };
  const applied: Record<Track, { early: number; late: number }> = {
    eCKM: { early: 0, late: 0 },
    CKM: { early: 0, late: 0 },
    MSK: { early: 0, late: 0 },
    BH: { early: 0, late: 0 },
  };
  const appliedType: Record<Track, "COA" | "SSA"> = { eCKM: "COA", CKM: "COA", MSK: "COA", BH: "COA" };

  TRACKS.forEach((t) => {
    effOAR[t] = inp.oar[t] * completionRate;

    const computeCOA = (oat: number) => (effOAR[t] >= oat ? 0 : Math.min(1 - effOAR[t] / oat, ADJ.coaCap));

    const ssaVal = inp.ssr[t] >= ADJ.sst ? 0 : Math.min(1 - inp.ssr[t] / ADJ.sst, ADJ.ssaCap);

    ssa[t] = ssaVal;
    coa[t] = { early: computeCOA(ADJ.oatM1to18), late: computeCOA(inp.oatM19to36) };
    applied[t] = { early: Math.max(coa[t].early, ssaVal), late: Math.max(coa[t].late, ssaVal) };
    appliedType[t] = coa[t].early >= ssaVal ? "COA" : "SSA";
  });

  // Step 7: net revenue with withheld accumulation
  const withheldAccum: Record<Track, number> = { eCKM: 0, CKM: 0, MSK: 0, BH: 0 };

  let pearlCumul = 0;
  let previousTotalEnrolled = 0;
  const full: FullRow[] = rawMonths.map((m) => {
    const isRecon = (RECON_MONTHS as readonly number[]).includes(m.T);
    const oatPeriod: "early" | "late" = m.T <= 18 ? "early" : "late";

    let netPaid = 0;
    let release = 0;

    tracks.forEach((t) => {
      netPaid += m.byTrack[t].paid * (1 - applied[t][oatPeriod]);
      withheldAccum[t] += m.byTrack[t].withheld;
    });

    netPaid = Math.max(0, netPaid + m.ruralRev - m.discount);

    if (isRecon) {
      tracks.forEach((t) => {
        release += withheldAccum[t] * (1 - applied[t][oatPeriod]);
        withheldAccum[t] = 0;
      });
    }

    const blendAdj = (() => {
      let n = 0,
        d = 0;
      tracks.forEach((t) => {
        const r = m.byTrack[t].paid + m.byTrack[t].withheld;
        n += applied[t][oatPeriod] * r;
        d += r;
      });
      return d > 0 ? n / d : 0;
    })();

    const netRev = netPaid + release;
    const pearlRev = netRev * inp.pearlShare;
    pearlCumul += pearlRev;

    const newlyEnrolledTotal = monthlyNewEnrollments[m.T].total;
    const netChange = m.totalEnrolled - previousTotalEnrolled;
    const churnedTotal = previousTotalEnrolled + newlyEnrolledTotal - m.totalEnrolled;
    const initialPeriodEnrolled = tracks.reduce((s, t) => s + m.byTrack[t].initial, 0);
    const followOnEnrolled = tracks.reduce((s, t) => s + m.byTrack[t].followOn, 0);
    const c1NewlyEnrolled = monthlyNewEnrollments[m.T].byCohort[1];
    const c2NewlyEnrolled = monthlyNewEnrollments[m.T].byCohort[2];
    const c3NewlyEnrolled = monthlyNewEnrollments[m.T].byCohort[3];

    previousTotalEnrolled = m.totalEnrolled;

    return {
      ...m,
      isRecon,
      netPaid,
      release,
      netRev,
      pearlRev,
      blendAdj,
      pearlCumul,
      newlyEnrolledTotal,
      churnedTotal,
      netChange,
      initialPeriodEnrolled,
      followOnEnrolled,
      c1NewlyEnrolled,
      c2NewlyEnrolled,
      c3NewlyEnrolled,
    };
  });

  // Step 8: summaries
  const pearlY1 = full.filter((r) => r.T <= 12).reduce((s, r) => s + r.pearlRev, 0);
  const pearlY2 = full.filter((r) => r.T >= 13 && r.T <= 24).reduce((s, r) => s + r.pearlRev, 0);
  const pearlY3 = full.filter((r) => r.T >= 25).reduce((s, r) => s + r.pearlRev, 0);
  const pearl3Y = pearlY1 + pearlY2 + pearlY3;

  const grossOAP3Y = full.reduce((s, r) => s + r.grossRev, 0);
  const netOAP3Y = full.reduce((s, r) => s + r.netRev, 0);

  const peakEnrolled = Math.max(...full.map((r) => r.totalEnrolled));
  const blendedAdj = (() => {
    let n = 0,
      d = 0;
    full.forEach((r) => {
      n += r.blendAdj * r.grossRev;
      d += r.grossRev;
    });
    return d > 0 ? n / d : 0;
  })();

  // Per-track Pearl revenue by year (for chart)
  const trackRevByYear: Record<Track, { Y1: number; Y2: number; Y3: number }> = {
    eCKM: { Y1: 0, Y2: 0, Y3: 0 },
    CKM: { Y1: 0, Y2: 0, Y3: 0 },
    MSK: { Y1: 0, Y2: 0, Y3: 0 },
    BH: { Y1: 0, Y2: 0, Y3: 0 },
  };

  full.forEach((r) => {
    const totalGross = tracks.reduce((s, t) => s + (r.byTrack[t].paid + r.byTrack[t].withheld), 0);
    if (totalGross === 0) return;

    const yk: "Y1" | "Y2" | "Y3" = r.T <= 12 ? "Y1" : r.T <= 24 ? "Y2" : "Y3";

    tracks.forEach((t) => {
      const share = (r.byTrack[t].paid + r.byTrack[t].withheld) / totalGross;
      trackRevByYear[t][yk] += r.pearlRev * share;
    });
  });

  // KPI table rows by year
  const kpiByYear = [0, 1, 2].map((i) => {
    const slice = full.filter((r) => Math.ceil(r.T / 12) === i + 1);
    return {
      label: `Year ${i + 1}`,
      gross: slice.reduce((s, r) => s + r.grossRev, 0),
      net: slice.reduce((s, r) => s + r.netRev, 0),
      pearl: slice.reduce((s, r) => s + r.pearlRev, 0),
      peakEnrolled: Math.max(...slice.map((r) => r.totalEnrolled)),
      blendAdj: (() => {
        let n = 0,
          d = 0;
        slice.forEach((r) => {
          n += r.blendAdj * r.grossRev;
          d += r.grossRev;
        });
        return d > 0 ? n / d : 0;
      })(),
      isTotal: false,
    };
  });

  return {
    months: full,
    kpi: { pearlY1, pearlY2, pearlY3, pearl3Y, grossOAP3Y, netOAP3Y, peakEnrolled, blendedAdj },
    adj: { effOAR, coa, ssa, applied, appliedType },
    prop,
    eligByYear,
    newEligY2,
    newEligY3,
    trackRevByYear,
    kpiByYear,
  };
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
const fmt$ = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;

const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmtInt = (v: number) => Math.round(v).toLocaleString();
const fmtYAxis = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v}`;

// ── UI COMPONENTS ─────────────────────────────────────────────────────────────
function Section({
  title,
  children,
  onReset,
}: {
  title: string;
  children: React.ReactNode;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-gray-200 rounded mb-3">
      <div className="flex items-center bg-gray-50 px-3 py-2">
        <button
          className="flex-1 text-left font-semibold text-sm flex items-center gap-1"
          onClick={() => setOpen((o) => !o)}
        >
          <span>{open ? "▲" : "▼"}</span>
          <span>{title}</span>
        </button>
        <button
          onClick={onReset}
          className="text-xs text-blue-600 hover:text-blue-800 border border-blue-300 rounded px-2 py-0.5 ml-2"
        >
          Reset section
        </button>
      </div>
      {open && <div className="px-4 py-3 space-y-3">{children}</div>}
    </div>
  );
}

function Row({
  label,
  children,
  tooltip,
}: {
  label: string;
  children: React.ReactNode;
  tooltip?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-44 shrink-0 text-xs text-gray-800 pt-1">
        {label}
        {tooltip && (
          <span className="ml-1 text-gray-800 cursor-help" title={tooltip}>
            ⓘ
          </span>
        )}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function NumInput({
  value,
  onChange,
  min = 0,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className="w-full border rounded px-2 py-1 text-sm"
    />
  );
}

function PctSlider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.005,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1"
      />
      <input
        type="number"
        value={(value * 100).toFixed(1)}
        step={step * 100}
        min={min * 100}
        max={max * 100}
        onChange={(e) => onChange((parseFloat(e.target.value) || 0) / 100)}
        className="w-16 border rounded px-2 py-1 text-sm"
      />
      <span className="text-xs text-gray-700">%</span>
    </div>
  );
}

function TrackFilter({
  activeTracks,
  onChange,
}: {
  activeTracks: Track[];
  onChange: (t: Track[]) => void;
}) {
  const pillColors: Record<Track, string> = {
    eCKM: "bg-blue-100 text-blue-800 border-blue-300",
    CKM: "bg-purple-100 text-purple-800 border-purple-300",
    MSK: "bg-green-100 text-green-800 border-green-300",
    BH: "bg-orange-100 text-orange-800 border-orange-300",
  };

  const toggle = (t: Track) => {
    if (activeTracks.includes(t)) {
      if (activeTracks.length === 1) return;
      onChange(activeTracks.filter((x) => x !== t));
    } else onChange([...activeTracks, t]);
  };

  const allOn = activeTracks.length === TRACKS.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-700 font-medium">Show tracks:</span>
      <button
        onClick={() => onChange(allOn ? [TRACKS[0]] : [...TRACKS])}
        className={`text-xs px-2 py-0.5 rounded border ${
          allOn ? "bg-gray-700 text-white border-gray-700" : "bg-white text-gray-800 border-gray-300"
        }`}
      >
        All
      </button>
      {TRACKS.map((t) => (
        <button
          key={t}
          onClick={() => toggle(t)}
          className={`text-xs px-2 py-0.5 rounded border font-medium transition-opacity ${
            pillColors[t]
          } ${activeTracks.includes(t) ? "opacity-100" : "opacity-30"}`}
        >
          {activeTracks.includes(t) ? "✓ " : ""}
          {t}
        </button>
      ))}
    </div>
  );
}

function exportCSV(months: FullRow[], tracks: Track[]) {
  const hdr = [
    "Month",
    "Year",
    "Recon",
    "Total Enrolled",
    "Newly Enrolled (total)",
    "Churned (total)",
    "Net Change",
    "Initial Period Enrolled",
    "Follow-On Enrolled",
    "C1 Newly Enrolled",
    "C2 Newly Enrolled",
    "C3 Newly Enrolled",
    ...tracks,
    "C1",
    "C2",
    "C3",
    "Gross Rev",
    "Paid",
    "Withheld",
    "Released",
    "Adj%",
    "Net Rev",
    "Pearl Rev",
    "Pearl Cumul",
  ];

  const rows = months.map((r) => [
    r.T,
    Math.ceil(r.T / 12),
    r.isRecon ? "Y" : "",
    Math.round(r.totalEnrolled),
    Math.round(r.newlyEnrolledTotal),
    Math.round(r.churnedTotal),
    Math.round(r.netChange),
    Math.round(r.initialPeriodEnrolled),
    Math.round(r.followOnEnrolled),
    Math.round(r.c1NewlyEnrolled),
    Math.round(r.c2NewlyEnrolled),
    Math.round(r.c3NewlyEnrolled),
    ...tracks.map((t) => Math.round(r.byTrack[t].initial + r.byTrack[t].followOn)),
    Math.round(r.byCohort[1]),
    Math.round(r.byCohort[2]),
    Math.round(r.byCohort[3]),
    r.grossRev.toFixed(2),
    r.paidRev.toFixed(2),
    r.withheldRev.toFixed(2),
    r.release.toFixed(2),
    (r.blendAdj * 100).toFixed(1) + "%",
    r.netRev.toFixed(2),
    r.pearlRev.toFixed(2),
    r.pearlCumul.toFixed(2),
  ]);

  const csv = [hdr, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "access_model.csv";
  a.click();
}

// ── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [inp, setInp] = useState<Inputs>(DEFAULTS);
  const [activeTracks, setActiveTracks] = useState<Track[]>([...TRACKS]);
  const [tableOpen, setTableOpen] = useState(false);
  const [inputsPanelOpen, setInputsPanelOpen] = useState(true);

  const set = useCallback((path: string, val: any) => {
    setInp((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split(".");
      let obj = next as any;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = val;
      return next;
    });
  }, []);

  const resetSection = useCallback((key: keyof typeof SECTION_KEYS) => {
    setInp((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      (SECTION_KEYS[key] as readonly string[]).forEach((k) => {
        (next as any)[k] = JSON.parse(JSON.stringify((DEFAULTS as any)[k]));
      });
      return next;
    });
  }, []);

  const resetAll = () => {
    setInp(JSON.parse(JSON.stringify(DEFAULTS)));
    setActiveTracks([...TRACKS]);
  };

  const model = useMemo(() => runModel(inp, activeTracks), [inp, activeTracks]);
  const { kpi, adj, prop, eligByYear, newEligY2, newEligY3, months, trackRevByYear, kpiByYear } = model;

  const chartData = [
    { year: "Year 1", ...Object.fromEntries(activeTracks.map((t) => [t, trackRevByYear[t]?.Y1 ?? 0])) },
    { year: "Year 2", ...Object.fromEntries(activeTracks.map((t) => [t, trackRevByYear[t]?.Y2 ?? 0])) },
    { year: "Year 3", ...Object.fromEntries(activeTracks.map((t) => [t, trackRevByYear[t]?.Y3 ?? 0])) },
  ];

  const kpiTableRows = [
    ...kpiByYear,
    {
      label: "3-Year Total",
      gross: kpi.grossOAP3Y,
      net: kpi.netOAP3Y,
      pearl: kpi.pearl3Y,
      peakEnrolled: kpi.peakEnrolled,
      blendAdj: kpi.blendedAdj,
      isTotal: true,
    },
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-4 bg-gray-100 min-h-screen text-sm text-gray-900">
      {/* ── INPUT PANEL ── */}
      {inputsPanelOpen && (
      <div className="w-full lg:w-[30rem] xl:w-[34rem] shrink-0 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-blue-800">ACCESS Calculator — Inputs</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={resetAll}
              className="text-xs bg-red-100 text-red-700 hover:bg-red-200 border border-red-300 rounded px-3 py-1 font-medium"
            >
              ↺ Reset All
            </button>
            <button
              onClick={() => setInputsPanelOpen(false)}
              className="text-xs bg-gray-200 text-gray-800 hover:bg-gray-300 border border-gray-300 rounded px-3 py-1 font-medium"
            >
              Hide inputs
            </button>
          </div>
        </div>

        <Section title="Panel Size & Growth" onReset={() => resetSection("panel")}>
          <Row label="Total Panel Size">
            <NumInput value={inp.totalPanel} onChange={(v) => set("totalPanel", v)} min={1} />
          </Row>
          {TRACKS.map((t) => (
            <Row key={t} label={`${t} Eligible`}>
              <NumInput value={inp.eligible[t]} onChange={(v) => set(`eligible.${t}`, v)} min={0} />
            </Row>
          ))}
          <div className="text-xs text-gray-700 bg-gray-50 rounded p-2 space-y-0.5">
            {TRACKS.map((t) => (
              <div key={t}>
                {t}: <span className="font-medium">{fmtPct(prop[t])}</span> of panel
              </div>
            ))}
          </div>
          <Row label="Y2 Growth Rate">
            <PctSlider value={inp.growthY2} onChange={(v) => set("growthY2", v)} min={0} max={1} step={0.01} />
          </Row>
          <Row label="Y3 Growth Rate">
            <PctSlider value={inp.growthY3} onChange={(v) => set("growthY3", v)} min={0} max={1} step={0.01} />
          </Row>
          <div className="text-xs text-gray-700 bg-gray-50 rounded p-2 space-y-0.5">
            <div className="font-medium">New eligible patients:</div>
            {TRACKS.map((t) => (
              <div key={t}>
                {t}: Y2 +{fmtInt(newEligY2[t])} / Y3 +{fmtInt(newEligY3[t])}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Enrollment & Penetration" onReset={() => resetSection("enrollment")}>
          <Row label="Mode">
            <div className="flex gap-2">
              {(["uniform", "perTrack"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    if (m === "perTrack") {
                      const v = inp.penetrationUniform;
                      setInp((p) => ({
                        ...p,
                        penetrationMode: "perTrack",
                        penetrationByTrack: { eCKM: v, CKM: v, MSK: v, BH: v },
                      }));
                    } else set("penetrationMode", "uniform");
                  }}
                  className={`px-2 py-1 rounded text-xs ${inp.penetrationMode === m ? "bg-blue-600 text-white" : "bg-gray-200"}`}
                >
                  {m === "uniform" ? "Uniform" : "Per Track"}
                </button>
              ))}
            </div>
          </Row>

          {inp.penetrationMode === "uniform" ? (
            <Row label="Penetration Rate">
              <PctSlider
                value={inp.penetrationUniform}
                onChange={(v) => set("penetrationUniform", v)}
                min={0.01}
                max={1}
                step={0.01}
              />
            </Row>
          ) : (
            TRACKS.map((t) => (
              <Row key={t} label={`${t} Penetration`}>
                <PctSlider
                  value={inp.penetrationByTrack[t]}
                  onChange={(v) => set(`penetrationByTrack.${t}`, v)}
                  min={0.01}
                  max={1}
                  step={0.01}
                />
              </Row>
            ))
          )}

          <Row label="Ramp Period" tooltip="Months to reach full enrollment, per cohort">
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={6}
                max={18}
                step={1}
                value={inp.rampPeriod}
                onChange={(e) => set("rampPeriod", parseInt(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm font-medium w-10">{inp.rampPeriod} mo</span>
            </div>
          </Row>

          <Row label="Control Group" tooltip="10% of eligible beneficiaries randomized to control per CMS RFA. Default: on for Year 1 only.">
            <div className="space-y-1.5">
              {(["Y1", "Y2", "Y3"] as const).map((yr, i) => (
                <div key={yr} className="flex items-center gap-2">
                  <span className="text-xs text-gray-700 w-12">Year {i + 1}:</span>
                  <button
                    onClick={() =>
                      setInp((p) => ({ ...p, controlGroupByYear: { ...p.controlGroupByYear, [yr]: !p.controlGroupByYear[yr] } }))
                    }
                    className={`px-3 py-0.5 rounded text-xs font-medium ${
                      inp.controlGroupByYear[yr] ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-800"
                    }`}
                  >
                    {inp.controlGroupByYear[yr] ? "ON (10% excluded)" : "OFF"}
                  </button>
                </div>
              ))}
            </div>
          </Row>

          <div className="text-xs text-gray-700 bg-gray-50 rounded p-2 space-y-0.5">
            <div className="font-medium">Peak enrolled (Cohort 1):</div>
            {TRACKS.map((t) => {
              const pen = inp.penetrationMode === "uniform" ? inp.penetrationUniform : inp.penetrationByTrack[t];
              return (
                <div key={t}>
                  {t}: {fmtInt(eligByYear.Y1[t] * pen * (inp.controlGroupByYear.Y1 ? 0.9 : 1.0))}
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Patient Flow & Retention" onReset={() => resetSection("flow")}>
          <Row label="Annual Churn Rate">
            <PctSlider value={inp.churnRate} onChange={(v) => set("churnRate", v)} min={0} max={0.5} step={0.005} />
          </Row>
          <div className="text-xs text-gray-800 -mt-1 ml-44">Monthly: {fmtPct(inp.churnRate / 12)}</div>
          <Row label="Multi-Track Overlap" tooltip="Placeholder — pending data science team data">
            <PctSlider value={inp.overlapRate} onChange={(v) => set("overlapRate", v)} min={0} max={0.4} step={0.005} />
          </Row>
          <div className="text-xs text-amber-600 bg-amber-50 rounded p-2">⚠ Overlap data pending from data science team</div>
        </Section>

        <Section title="Financial & Revenue" onReset={() => resetSection("financial")}>
          <Row label="Cost-Sharing Policy">
            <button
              onClick={() => set("costSharingWaived", !inp.costSharingWaived)}
              className={`px-3 py-1 rounded text-sm font-medium ${
                inp.costSharingWaived ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700"
              }`}
            >
              {inp.costSharingWaived ? "Waive (Medicare 80%)" : "Collect (100%)"}
            </button>
          </Row>
          {!inp.costSharingWaived && <div className="text-xs text-amber-600 bg-amber-50 rounded p-2">⚠ Must disclose cost-sharing before enrollment</div>}
          <Row label="Rural Patient %">
            <PctSlider value={inp.ruralPct} onChange={(v) => set("ruralPct", v)} min={0} max={1} step={0.01} />
          </Row>
          <Row label="Pearl Revenue Share">
            <PctSlider value={inp.pearlShare} onChange={(v) => set("pearlShare", v)} min={0.05} max={0.5} step={0.005} />
          </Row>
        </Section>

        <Section title="Performance Assumptions" onReset={() => resetSection("performance")}>
          <div className="text-xs font-semibold text-gray-800 mb-1">Outcome Attainment Rate (OAR)</div>
          {TRACKS.map((t) => (
            <Row key={t} label={`${t} OAR`}>
              <PctSlider value={inp.oar[t]} onChange={(v) => set(`oar.${t}`, v)} min={0} max={1} step={0.01} />
            </Row>
          ))}
          <Row label="OAT (M19–36)" tooltip="Months 1–18 fixed at 50% per CMS rules">
            <PctSlider value={inp.oatM19to36} onChange={(v) => set("oatM19to36", v)} min={0.6} max={0.65} step={0.005} />
          </Row>
          <div className="text-xs text-gray-800 -mt-1 ml-44">M1–18 OAT: 50% (fixed by CMS)</div>
          <div className="text-xs font-semibold text-gray-800 mb-1 mt-2">Substitute Spend Rate (SSR)</div>
          {TRACKS.map((t) => (
            <Row key={t} label={`${t} SSR`}>
              <PctSlider value={inp.ssr[t]} onChange={(v) => set(`ssr.${t}`, v)} min={0} max={1} step={0.01} />
            </Row>
          ))}
        </Section>
      </div>
      )}

      {/* ── OUTPUT PANEL ── */}
      <div className="flex-1 overflow-y-auto space-y-4 min-w-0">
        {!inputsPanelOpen && (
          <div className="flex justify-start">
            <button
              onClick={() => setInputsPanelOpen(true)}
              className="text-xs bg-blue-600 text-white hover:bg-blue-700 border border-blue-700 rounded px-3 py-1 font-medium"
            >
              Show inputs
            </button>
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-base font-bold text-blue-800">Outputs</h2>
          <div className="bg-white rounded border border-gray-200 px-3 py-2">
            <TrackFilter activeTracks={activeTracks} onChange={setActiveTracks} />
          </div>
        </div>

        {activeTracks.length < TRACKS.length && (
          <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
            Showing {activeTracks.join(", ")} only — all figures scoped to selected tracks.
          </div>
        )}

        {/* KPI Summary Table */}
        <div className="bg-white rounded border border-gray-200 p-4">
          <h3 className="font-semibold text-sm mb-3">Summary Metrics by Year</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-700 border-b border-gray-200">
                  <th className="text-left py-2 pr-4 font-medium w-28"></th>
                  <th className="text-right py-2 px-3 font-medium">Gross OAP Rev</th>
                  <th className="text-right py-2 px-3 font-medium">Net OAP Rev</th>
                  <th className="text-right py-2 px-3 font-medium text-blue-700">Pearl Net Rev</th>
                  <th className="text-right py-2 px-3 font-medium">Peak Enrolled</th>
                  <th className="text-right py-2 px-3 font-medium">Blended Adj.</th>
                </tr>
              </thead>
              <tbody>
                {kpiTableRows.map((row) => (
                  <tr
                    key={row.label}
                    className={`border-b border-gray-100 ${
                      row.isTotal ? "font-bold bg-blue-50 border-t-2 border-t-blue-200" : "hover:bg-gray-50"
                    }`}
                  >
                    <td className={`py-2 pr-4 text-sm ${row.isTotal ? "text-blue-800" : "text-gray-800"}`}>{row.label}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{fmt$(row.gross)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{fmt$(row.net)}</td>
                    <td className={`py-2 px-3 text-right tabular-nums font-semibold ${row.isTotal ? "text-blue-700 text-base" : "text-blue-600"}`}>
                      {fmt$(row.pearl)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{fmtInt(row.peakEnrolled)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{fmtPct(row.blendAdj)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Stacked Bar Chart */}
        <div className="bg-white rounded border border-gray-200 p-4">
          <h3 className="font-semibold text-sm mb-1">Pearl Net Revenue by Track & Year</h3>
          <p className="text-xs text-gray-800 mb-3">Each segment shows a track's contribution to Pearl's net revenue per year</p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ top: 4, right: 16, left: 16, bottom: 4 }}>
              <XAxis dataKey="year" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={fmtYAxis} tick={{ fontSize: 11 }} width={64} />
              <Tooltip formatter={(v: any, name: any) => [fmt$(Number(v)), String(name)]} contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {activeTracks.map((t) => (
                <Bar
                  key={t}
                  dataKey={t}
                  stackId="a"
                  fill={TRACK_COLORS[t]}
                  radius={t === activeTracks[activeTracks.length - 1] ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Adjustment Transparency Table */}
        <div className="bg-white rounded border border-gray-200 p-3">
          <h3 className="font-semibold text-sm mb-2">Performance Adjustment Transparency</h3>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead>
                <tr className="bg-gray-50 text-gray-800 whitespace-nowrap">
                  <th className="text-left px-2 py-1">Track</th>
                  <th className="px-2 py-1">Clinical OAR</th>
                  <th className="px-2 py-1">Effective OAR</th>
                  <th className="px-2 py-1">OAT M1–18</th>
                  <th className="px-2 py-1">OAT M19–36</th>
                  <th className="px-2 py-1">COA (early)</th>
                  <th className="px-2 py-1">SSR</th>
                  <th className="px-2 py-1">SST</th>
                  <th className="px-2 py-1">SSA</th>
                  <th className="px-2 py-1 font-bold">Applied (early)</th>
                  <th className="px-2 py-1">Type</th>
                </tr>
              </thead>
              <tbody>
                {activeTracks.map((t) => {
                  const coaE = adj.coa[t].early,
                    ssaV = adj.ssa[t],
                    appE = adj.applied[t].early,
                    isCoA = coaE >= ssaV;

                  return (
                    <tr key={t} className="border-t">
                      <td className="px-2 py-1 font-medium">{t}</td>
                      <td className="px-2 py-1 text-center">{fmtPct(inp.oar[t])}</td>
                      <td className="px-2 py-1 text-center">{fmtPct(adj.effOAR[t])}</td>
                      <td className="px-2 py-1 text-center">50.0%</td>
                      <td className="px-2 py-1 text-center">{fmtPct(inp.oatM19to36)}</td>
                      <td className={`px-2 py-1 text-center ${isCoA && coaE > 0 ? "bg-red-100 text-red-700" : ""}`}>{fmtPct(coaE)}</td>
                      <td className="px-2 py-1 text-center">{fmtPct(inp.ssr[t])}</td>
                      <td className="px-2 py-1 text-center">90.0%</td>
                      <td className={`px-2 py-1 text-center ${!isCoA && ssaV > 0 ? "bg-orange-100 text-orange-700" : ""}`}>{fmtPct(ssaV)}</td>
                      <td className={`px-2 py-1 text-center font-bold ${appE > 0 ? "bg-red-200 text-red-800" : "bg-green-100 text-green-700"}`}>{fmtPct(appE)}</td>
                      <td className="px-2 py-1 text-center text-gray-700">{adj.appliedType[t]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Monthly Data Table */}
        <div className="bg-white rounded border border-gray-200 p-3">
          <div className="flex justify-between items-center mb-2">
            <button className="font-semibold text-sm flex items-center gap-1" onClick={() => setTableOpen((o) => !o)}>
              Month-by-Month Data {tableOpen ? "▲" : "▼"}
            </button>
            <button
              onClick={() => exportCSV(months, activeTracks)}
              className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
            >
              Export CSV
            </button>
          </div>

          {tableOpen && (
            <div className="overflow-x-auto">
              <table className="text-xs w-full whitespace-nowrap">
                <thead>
                  <tr className="bg-gray-50 text-gray-800">
                    <th className="px-1 py-1">Mo</th>
                    <th className="px-1 py-1">Yr</th>
                    <th className="px-1 py-1">Rec</th>
                    <th className="px-1 py-1">Enrolled</th>
                    <th className="px-1 py-1">Newly Enrolled (Total)</th>
                    <th className="px-1 py-1">Churned (Total)</th>
                    <th className="px-1 py-1">Net Change</th>
                    <th className="px-1 py-1">Initial Period Enrolled</th>
                    <th className="px-1 py-1">Follow-On Enrolled</th>
                    <th className="px-1 py-1">C1 Newly Enrolled</th>
                    <th className="px-1 py-1">C2 Newly Enrolled</th>
                    <th className="px-1 py-1">C3 Newly Enrolled</th>
                    {activeTracks.map((t) => (
                      <th key={t} className="px-1 py-1">
                        {t}
                      </th>
                    ))}
                    <th className="px-1 py-1">C1</th>
                    <th className="px-1 py-1">C2</th>
                    <th className="px-1 py-1">C3</th>
                    <th className="px-1 py-1">Gross Rev</th>
                    <th className="px-1 py-1">Paid</th>
                    <th className="px-1 py-1">Withheld</th>
                    <th className="px-1 py-1">Released</th>
                    <th className="px-1 py-1">Adj%</th>
                    <th className="px-1 py-1">Net Rev</th>
                    <th className="px-1 py-1 text-blue-700">Pearl Rev</th>
                    <th className="px-1 py-1">Pearl Cumul</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((r) => (
                    <tr key={r.T} className={`border-t ${r.isRecon ? "bg-yellow-50" : ""}`}>
                      <td className="px-1 py-0.5 text-center">{r.T}</td>
                      <td className="px-1 py-0.5 text-center">{Math.ceil(r.T / 12)}</td>
                      <td className="px-1 py-0.5 text-center">{r.isRecon ? "✓" : ""}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.totalEnrolled)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.newlyEnrolledTotal)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.churnedTotal)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.netChange)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.initialPeriodEnrolled)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.followOnEnrolled)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.c1NewlyEnrolled)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.c2NewlyEnrolled)}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.c3NewlyEnrolled)}</td>
                      {activeTracks.map((t) => (
                        <td key={t} className="px-1 py-0.5 text-right">
                          {fmtInt(r.byTrack[t].initial + r.byTrack[t].followOn)}
                        </td>
                      ))}
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.byCohort[1])}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.byCohort[2])}</td>
                      <td className="px-1 py-0.5 text-right">{fmtInt(r.byCohort[3])}</td>
                      <td className="px-1 py-0.5 text-right">{fmt$(r.grossRev)}</td>
                      <td className="px-1 py-0.5 text-right">{fmt$(r.paidRev)}</td>
                      <td className="px-1 py-0.5 text-right">{fmt$(r.withheldRev)}</td>
                      <td className="px-1 py-0.5 text-right">{r.isRecon ? fmt$(r.release) : ""}</td>
                      <td className="px-1 py-0.5 text-right">{fmtPct(r.blendAdj)}</td>
                      <td className="px-1 py-0.5 text-right">{fmt$(r.netRev)}</td>
                      <td className="px-1 py-0.5 text-right font-medium text-blue-700">{fmt$(r.pearlRev)}</td>
                      <td className="px-1 py-0.5 text-right font-medium">{fmt$(r.pearlCumul)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
