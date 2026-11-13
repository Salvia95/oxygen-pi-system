// combo 결과의 CI 판정 (docs/skill-combo-spec.md §4, C3): 시나리오마다 반복 중 1번 이상 합격이면 통과,
// 기준선(baseline-combo.json)에서 통과였던 시나리오가 통과하지 못하면 실패. 합격 = 결과 PASS 이고 기대 skill 중 2개 이상 실행
export const accepted = (r) => Boolean(r.pass && (r.skillsUsed ?? 0) >= 2);

/** rows: 이번 실행의 기록(반복 포함), baseline: { accepted: [시나리오 id] } → { ok, scenarios: [{id, runs, accepted, inBaseline}], regressed, improved } */
export function gate(rows, baseline) {
  const ids = [...new Set(rows.map((r) => r.scenario))];
  const base = new Set(baseline?.accepted ?? []);
  const scenarios = ids.map((id) => {
    const rs = rows.filter((r) => r.scenario === id);
    return { id, runs: rs.length, passCount: rs.filter(accepted).length, accepted: rs.some(accepted), inBaseline: base.has(id) };
  });
  const regressed = scenarios.filter((s) => s.inBaseline && !s.accepted).map((s) => s.id);
  const missing = [...base].filter((id) => !ids.includes(id));   // 기준선에 있는데 이번에 돌지 않은 시나리오도 실패
  const improved = scenarios.filter((s) => !s.inBaseline && s.accepted).map((s) => s.id);
  return { ok: regressed.length === 0 && missing.length === 0, scenarios, regressed: [...regressed, ...missing], improved };
}
