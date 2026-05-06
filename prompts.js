// ═══════════════════════════════════════════════════════════
// prompts.js — Decision Pipeline Agent Prompts
//
// 9-step pipeline. The LLM is used for framing, research, parameter
// selection, narrative interpretation, adversarial review, forecasting
// and synthesis. The Monte Carlo simulation and sensitivity analysis
// are deterministic Python (simulator.py) — the LLM never writes or
// fabricates numerical results.
//
// Flow:
//   FRAMEWORK -> ORACLE || ECHO -> MODEL_PARAMS -> SIMULATE (Python)
//             -> MODEL_INTERPRET -> DEVIL || SAGE -> NEXUS -> MIRROR
// ═══════════════════════════════════════════════════════════

function formatDecisionContext(d) {
  var t = '# Decision Analysis Input\n\n';
  t += '## Decision\n' + d.decision + '\n';
  t += 'Deadline: ' + (d.deadline || 'Not specified') + '\n\n';
  t += '## About the Decision Maker\n';
  for (var k in d.context) t += '- **' + k + '**: ' + d.context[k] + '\n';
  t += '\n## Options\n';
  d.options.forEach(function(o, i) {
    t += '\n### Option ' + (i+1) + ': ' + o.name + '\n';
    if (o.description) t += o.description + '\n';
    if (o.facts) for (var fk in o.facts) t += '- ' + fk + ': ' + o.facts[fk] + '\n';
    if (o.status) t += '- Status: ' + o.status + '\n';
    if (o.deadline) t += '- Deadline: ' + o.deadline + '\n';
  });
  t += '\n## Values & Priorities\n';
  t += '- **Goal**: ' + (d.goal || 'Not stated') + '\n';
  t += '- **Priorities**: ' + (d.priorities || 'Not stated') + '\n';
  if (d.concerns && d.concerns.length) t += '- **Concerns**: ' + d.concerns.join('; ') + '\n';
  if (d.traits && d.traits.length) {
    t += '- **Self-assessment**: ' + d.traits.map(function(tr) { return tr.name + ': ' + tr.value + '/10'; }).join(', ') + '\n';
  }
  if (d.notes) t += '- **Notes**: ' + d.notes + '\n';
  return t;
}

function optionNames(d) {
  return d.options.map(function(o) { return o.name; });
}

// ── 1. FRAMEWORK ─────────────────────────────────────────

function buildFrameworkPrompt(allData) {
  var names = optionNames(allData);
  var relMap = names.reduce(function(m, n) { m[n] = 'high|medium|low'; return m; }, {});

  return {
    max_tokens: 8192,
    messages: [
      {
        role: 'system',
        content: 'You are FRAMEWORK, the analytical architect of a decision analysis team. Read the user\'s decision and dynamically generate the complete analytical framework: evaluation dimensions, scenarios, outcome tracks, personality adjustments, and forward-looking modules. Everything is tailored to THIS decision — nothing generic.\n\nReturn ONLY a valid JSON object. No markdown, no explanation.'
      },
      {
        role: 'user',
        content: formatDecisionContext(allData) + '\n\n---\n\n' +
          'Generate the analytical framework as JSON:\n\n' +
          '{\n' +
          '  "decision_type": "short category label",\n' +
          '  "evaluation_dimensions": [\n' +
          '    {"id": "snake_case", "name": "Human Name", "weight": 0.25, "description": "what this measures", "scoring_guide": "how to score 0-100"}\n' +
          '  ],\n' +
          '  "scenarios": [\n' +
          '    {"id": "snake_case", "name": "Name", "probability": 0.40, "description": "what this assumes", "adjustments": {"hint_for_outcome_distributions": "free text"}}\n' +
          '  ],\n' +
          '  "outcome_tracks": [\n' +
          '    {"id": "snake_case", "name": "Track Name", "description": "what this path looks like", "relevance_per_option": ' + JSON.stringify(relMap) + '}\n' +
          '  ],\n' +
          '  "personality_adjustments": [\n' +
          '    {"trait": "from self-assessment", "weight": 0.10, "effect": "how it affects outcomes"}\n' +
          '  ],\n' +
          '  "forward_modules": [\n' +
          '    {"id": "snake_case", "name": "Module Name", "description": "what to analyze", "relevant_options": ' + JSON.stringify(names) + '}\n' +
          '  ],\n' +
          '  "risk_parameters": {"same_tier_threshold_pct": 10}\n' +
          '}\n\n' +
          'Rules:\n' +
          '- 4-7 evaluation dimensions, weights sum to 1.0\n' +
          '- 3-6 scenarios, probabilities sum to 1.0 (always include "baseline")\n' +
          '- 3-6 outcome tracks reflecting realistic paths/states\n' +
          '- Map user self-assessment traits to personality adjustments\n' +
          '- 3-5 forward modules based on decision type and context\n' +
          '- ALL content specific to this decision\n\n' +
          'Return ONLY the JSON.'
      }
    ]
  };
}

// ── 2. ORACLE ────────────────────────────────────────────

function buildOraclePrompt(allData, framework) {
  var dimIds = framework.evaluation_dimensions.map(function(d) { return d.id; });
  var dimGuides = framework.evaluation_dimensions.map(function(d) {
    return '- **' + d.name + '** (' + d.id + ', weight ' + d.weight + '): ' + d.scoring_guide;
  }).join('\n');

  return {
    max_tokens: 8192,
    messages: [
      {
        role: 'system',
        content: 'You are ORACLE, the official information researcher. Verify facts about each option using authoritative knowledge. Score each option on every evaluation dimension (0-100). Mark confidence levels honestly. "Unknown" is better than a guess.\n\nReturn ONLY a valid JSON object.'
      },
      {
        role: 'user',
        content: formatDecisionContext(allData) + '\n\n' +
          'Evaluation dimensions:\n' + dimGuides + '\n\n---\n\n' +
          'Research each option and score on all dimensions:\n\n' +
          '{\n' +
          '  "options": [\n' +
          '    {\n' +
          '      "name": "option name",\n' +
          '      "verified_facts": {"key": {"value": "...", "confidence": "high|medium|low"}},\n' +
          '      "corrections": ["corrections to user input, if any"],\n' +
          '      "dimension_scores": {"' + dimIds[0] + '": {"score": 75, "reasoning": "why"}},\n' +
          '      "key_strengths": ["strength"],\n' +
          '      "key_risks": ["risk"],\n' +
          '      "data_confidence": 0.85\n' +
          '    }\n' +
          '  ],\n' +
          '  "cross_option_notes": ["comparative observations"]\n' +
          '}\n\n' +
          'Score ALL dimensions for ALL options: ' + dimIds.join(', ') + '\n' +
          'Return ONLY the JSON.'
      }
    ]
  };
}

// ── 3. ECHO ──────────────────────────────────────────────

function buildEchoPrompt(allData, framework) {
  return {
    max_tokens: 8192,
    messages: [
      {
        role: 'system',
        content: 'You are ECHO, the community sentiment researcher. Report what real people say about each option — both positive AND negative. You check forums, review sites, social media, and community platforms. Be honest about negative feedback. Flag survivorship bias.\n\nReturn ONLY a valid JSON object.'
      },
      {
        role: 'user',
        content: formatDecisionContext(allData) + '\n\n---\n\n' +
          'Report community sentiment for each option:\n\n' +
          '{\n' +
          '  "options": [\n' +
          '    {\n' +
          '      "name": "option name",\n' +
          '      "overall_sentiment": "positive|mixed|negative",\n' +
          '      "confidence_in_sentiment": "high|medium|low",\n' +
          '      "estimated_sample": "how much data is likely available",\n' +
          '      "praise": [{"point": "what people like", "frequency": "common|occasional|rare"}],\n' +
          '      "complaints": [{"point": "what people dislike", "frequency": "common|occasional|rare"}],\n' +
          '      "outcome_anecdotes": [{"anecdote": "real outcome story", "type": "success|failure|mixed"}],\n' +
          '      "red_flags": ["consistent warning signs"],\n' +
          '      "hidden_gems": ["underappreciated positives"],\n' +
          '      "survivorship_bias_note": "bias assessment"\n' +
          '    }\n' +
          '  ],\n' +
          '  "comparative_sentiment": "which option has strongest/weakest community support"\n' +
          '}\n\n' +
          'Do NOT filter negative opinions. Distinguish common from rare complaints.\n' +
          'Return ONLY the JSON.'
      }
    ]
  };
}

// ── 4. MODEL_PARAMS — LLM emits a simulation spec; it does NOT compute results ──

function buildModelParamsPrompt(allData, framework, oracle, echo) {
  var names = optionNames(allData);

  return {
    max_tokens: 12288,
    messages: [
      {
        role: 'system',
        content:
          'You are MODEL-PARAMS, the parameter author for a Monte Carlo simulator. ' +
          'You DO NOT compute results. You DO NOT estimate means, medians, NPVs, percentiles or rankings. ' +
          'Your only job is to translate the framework + research into structured input parameters that a deterministic Python simulator (simulator.py) will execute.\n\n' +
          'You select distributions from a fixed menu and fill numeric parameters. Any value you write is a *prior assumption*, not a *result*. The actual numbers come from the simulator.\n\n' +
          'Return ONLY a valid JSON object matching the sim_spec contract below.'
      },
      {
        role: 'user',
        content:
          '## Framework\n```json\n' + JSON.stringify(framework, null, 2) + '\n```\n\n' +
          '## ORACLE Research\n```json\n' + JSON.stringify(oracle, null, 2) + '\n```\n\n' +
          '## ECHO Sentiment\n```json\n' + JSON.stringify(echo, null, 2) + '\n```\n\n' +
          formatDecisionContext(allData) + '\n\n---\n\n' +
          'Emit a sim_spec for the deterministic simulator:\n\n' +
          '```\n' +
          '{\n' +
          '  "options": ' + JSON.stringify(names) + ',\n' +
          '  "scenarios": [\n' +
          '    {"id": "snake_id", "probability": 0.50, "description": "..."}\n' +
          '    // 2-5 scenarios, probabilities sum to 1.0; align with framework.scenarios where possible\n' +
          '  ],\n' +
          '  "outcomes": [\n' +
          '    {\n' +
          '      "id": "snake_id",\n' +
          '      "name": "Display Name",\n' +
          '      "direction": "higher_better" | "lower_better",\n' +
          '      "weight": 0.4,                    // weights across outcomes sum to 1.0\n' +
          '      "expected_range": [min, max],    // used to normalize this outcome to a 0-100 utility scale\n' +
          '      "per_option": {\n' +
          '        "<each option name>": {\n' +
          '          "<each scenario id>": {"dist": "...", "params": {...}}\n' +
          '        }\n' +
          '      }\n' +
          '    }\n' +
          '  ],\n' +
          '  "n_iterations": 10000,\n' +
          '  "seed": 42\n' +
          '}\n' +
          '```\n\n' +
          'Allowed distributions (use ONLY these, exact spelling):\n' +
          '- normal       — params: {mean, sd}\n' +
          '- lognormal    — params: {mean, sd}    // mean and sd of the underlying normal\n' +
          '- triangular   — params: {min, mode, max}\n' +
          '- beta         — params: {alpha, beta, min, max}\n' +
          '- uniform      — params: {min, max}\n' +
          '- bernoulli    — params: {p}            // returns 0 or 1\n' +
          '- categorical  — params: {choices: [{value, p}, ...]}  // probabilities sum to 1.0\n\n' +
          'Hard rules:\n' +
          '- 3-6 outcomes that materially drive the decision (cost, time, satisfaction, success-likelihood, etc. — pick what fits this decision).\n' +
          '- For EVERY outcome × EVERY option × EVERY scenario, supply a distribution.\n' +
          '- expected_range must reflect the realistic min/max of that outcome across all options/scenarios; this is what the simulator uses to normalize to 0-100. Pick it once per outcome.\n' +
          '- direction "higher_better" or "lower_better" — costs and risks are lower_better; satisfaction and success rates are higher_better.\n' +
          '- Use lognormal for highly-skewed positive quantities (income, cost). Use triangular when you have a "best estimate, plausible low, plausible high". Use beta when modeling rates/probabilities with uncertainty. Use bernoulli only for binary events.\n' +
          '- Distribution params must be self-consistent (sd > 0; min < mode < max for triangular; min < max for beta/uniform; categorical probabilities sum to 1.0).\n' +
          '- n_iterations: 10000 is the default. Use 5000 for a fast first pass.\n\n' +
          'Return ONLY the JSON. No prose, no markdown fence around the whole answer.'
      }
    ]
  };
}

// ── 5. MODEL_INTERPRET — LLM reads real simulation output and narrates ──

function buildModelInterpretPrompt(allData, framework, oracle, echo, sim_spec, sim_results) {
  var rp = framework.risk_parameters || {};
  var threshold = rp.same_tier_threshold_pct || 10;

  return {
    max_tokens: 8192,
    messages: [
      {
        role: 'system',
        content:
          'You are MODEL-INTERPRET. The deterministic Python simulator has just produced real Monte Carlo results from the sim_spec you saw. ' +
          'The numbers in sim_results are computed, not invented — DO NOT contradict them or substitute your own. Your job is to read the real distributions and explain them.\n\n' +
          'Return ONLY a valid JSON object.'
      },
      {
        role: 'user',
        content:
          '## Framework\n```json\n' + JSON.stringify(framework, null, 2) + '\n```\n\n' +
          '## sim_spec (parameters used)\n```json\n' + JSON.stringify(sim_spec, null, 2) + '\n```\n\n' +
          '## sim_results (real Monte Carlo output)\n```json\n' + JSON.stringify(sim_results, null, 2) + '\n```\n\n' +
          formatDecisionContext(allData) + '\n\n---\n\n' +
          'Interpret the simulation. Same-tier threshold = ' + threshold + '%.\n\n' +
          '{\n' +
          '  "ranking": [/* mirror sim_results.ranking exactly */],\n' +
          '  "top1": "name",\n' +
          '  "top2": "name (or null if only one option)",\n' +
          '  "utility_gap_pct": <copy sim_results.top1_vs_top2_utility_gap_pct>,\n' +
          '  "ranking_stability": "<copy sim_results.ranking_stability>",\n' +
          '  "conclusion_type": "strong_recommend | same_tier | insufficient_data",\n' +
          '  "conclusion_reasoning": "why this classification, citing specific simulation numbers",\n' +
          '  "what_drives_the_ranking": "which 1-2 outcomes contribute most to the top-1 result",\n' +
          '  "biggest_risk_per_option": {"<option>": "the most concerning outcome distribution for this option"},\n' +
          '  "most_sensitive_lever": "which weight or scenario probability would most easily flip the ranking — quote from sim_results.sensitivity",\n' +
          '  "concerns_about_priors": ["any concern that the priors (sim_spec params) over- or under-state reality — be candid"]\n' +
          '}\n\n' +
          'Classify conclusion_type:\n' +
          '- strong_recommend: utility_gap_pct >= threshold AND ranking_stability == "stable" AND no major concerns_about_priors\n' +
          '- same_tier: utility_gap_pct < threshold OR ranking_stability == "unstable"\n' +
          '- insufficient_data: ORACLE data_confidence < 0.6 for top option, OR concerns_about_priors are severe\n\n' +
          'Return ONLY the JSON.'
      }
    ]
  };
}

// ── 6. DEVIL ─────────────────────────────────────────────

function buildDevilPrompt(allData, framework, oracle, echo, sim_spec, sim_results, interpret) {
  return {
    max_tokens: 8192,
    messages: [
      {
        role: 'system',
        content: 'You are DEVIL, the adversarial critic. Attack the analysis to make it stronger. Challenge the #1 option, defend the last-ranked, find data inconsistencies, flag biases, and identify the single assumption everything depends on.\n\nThe simulation numbers are deterministic — do not dispute them. Instead challenge: are the priors (distributions in sim_spec) realistic? Are weights right? Are scenarios complete? Is sentiment biased? Is the conclusion robust?\n\nSeverity: critical (could flip ranking), moderate (affects confidence), minor (worth noting).\n\nReturn ONLY a valid JSON object.'
      },
      {
        role: 'user',
        content:
          '## Interpret\n```json\n' + JSON.stringify(interpret, null, 2) + '\n```\n\n' +
          '## sim_results (deterministic)\n```json\n' + JSON.stringify(sim_results, null, 2) + '\n```\n\n' +
          '## sim_spec (priors)\n```json\n' + JSON.stringify(sim_spec, null, 2) + '\n```\n\n' +
          '## ORACLE\n```json\n' + JSON.stringify(oracle, null, 2) + '\n```\n\n' +
          '## ECHO\n```json\n' + JSON.stringify(echo, null, 2) + '\n```\n\n' +
          '## Framework\n```json\n' + JSON.stringify(framework, null, 2) + '\n```\n\n' +
          formatDecisionContext(allData) + '\n\n---\n\n' +
          '{\n' +
          '  "challenges": [\n' +
          '    {"id": "DEVIL-001", "severity": "critical|moderate|minor", "target": "agent/assumption/prior", "title": "title", "issue": "problem", "evidence": "why wrong", "impact": "ranking change", "recommendation": "fix"}\n' +
          '  ],\n' +
          '  "winner_vulnerability": {\n' +
          '    "option": "#1 name", "most_likely_disappointment": "...",\n' +
          '    "key_assumption_at_risk": "assumption that if wrong drops it",\n' +
          '    "evidence_strength": "how strong is #1 evidence vs alternatives"\n' +
          '  },\n' +
          '  "loser_defense": {\n' +
          '    "option": "last name", "undervalued_aspects": ["ignored strengths"],\n' +
          '    "scenario_where_best": "when this wins",\n' +
          '    "driven_by_one_outcome": "is low rank from one bad outcome that may not matter to this user?"\n' +
          '  },\n' +
          '  "bias_flags": [{"type": "survivorship|anchoring|hallucination|selection|prior_misspecification", "description": "...", "severity": "high|medium|low"}],\n' +
          '  "data_consistency_issues": ["contradictions"],\n' +
          '  "single_biggest_assumption": "the ONE assumption (usually a prior in sim_spec) the conclusion hinges on"\n' +
          '}\n\n' +
          'At least 3 challenges, at least 1 critical or moderate.\n' +
          'Return ONLY the JSON.'
      }
    ]
  };
}

// ── 7. SAGE ──────────────────────────────────────────────

function buildSagePrompt(allData, framework) {
  var moduleList = (framework.forward_modules || []).map(function(m) {
    return '- **' + m.name + '**: ' + m.description + ' (relevant: ' + (m.relevant_options || []).join(', ') + ')';
  }).join('\n');

  return {
    max_tokens: 8192,
    messages: [
      {
        role: 'system',
        content: 'You are SAGE, the future trends forecaster. Score forward-looking modules 0-100 using best available evidence.\n\n0-30: Significantly negative · 30-50: Slightly negative · 50: Neutral · 50-70: Slightly positive · 70-100: Significantly positive\n\nDistinguish prediction from fact. State time horizons. Flag uncertainty.\n\nReturn ONLY a valid JSON object.'
      },
      {
        role: 'user',
        content: formatDecisionContext(allData) + '\n\n' +
          '## Forward Modules to Score\n' + moduleList + '\n\n---\n\n' +
          '{\n' +
          '  "modules": [\n' +
          '    {\n' +
          '      "id": "module_id", "name": "Name", "score": 65,\n' +
          '      "direction": "improving|stable|deteriorating",\n' +
          '      "confidence": "high|medium|low",\n' +
          '      "time_horizon": "2026-2028",\n' +
          '      "rationale": "2-3 sentences with data points",\n' +
          '      "key_data_point": "most important fact",\n' +
          '      "per_option_impact": {"Option Name": "tailwind|headwind|neutral — brief"}\n' +
          '    }\n' +
          '  ],\n' +
          '  "macro_outlook_summary": "1-2 sentence environment assessment",\n' +
          '  "biggest_uncertainty": "highest-variance factor that could swing the decision"\n' +
          '}\n\n' +
          'Return ONLY the JSON.'
      }
    ]
  };
}

// ── 8. NEXUS ─────────────────────────────────────────────

function buildNexusPrompt(allData, framework, oracle, echo, sim_spec, sim_results, interpret, devil, sage) {
  return {
    max_tokens: 16384,
    messages: [
      {
        role: 'system',
        content: 'You are NEXUS, the decision architect. Integrate ALL analysis into one clear, actionable recommendation. Address every critical/moderate DEVIL challenge. Adjust confidence based on SAGE outlook. Include deadline-aware action items. Write a comprehensive Markdown report grounded in the deterministic simulation numbers — NOT in invented statistics.\n\nReturn ONLY a valid JSON object with a thorough report_markdown field.'
      },
      {
        role: 'user',
        content: '## User Context\n' + formatDecisionContext(allData) + '\n\n' +
          '## Framework\n```json\n' + JSON.stringify(framework, null, 2) + '\n```\n\n' +
          '## ORACLE\n```json\n' + JSON.stringify(oracle, null, 2) + '\n```\n\n' +
          '## ECHO\n```json\n' + JSON.stringify(echo, null, 2) + '\n```\n\n' +
          '## sim_spec (priors)\n```json\n' + JSON.stringify(sim_spec, null, 2) + '\n```\n\n' +
          '## sim_results (deterministic Monte Carlo)\n```json\n' + JSON.stringify(sim_results, null, 2) + '\n```\n\n' +
          '## MODEL-INTERPRET\n```json\n' + JSON.stringify(interpret, null, 2) + '\n```\n\n' +
          '## DEVIL\n```json\n' + JSON.stringify(devil, null, 2) + '\n```\n\n' +
          '## SAGE\n```json\n' + JSON.stringify(sage, null, 2) + '\n```\n\n---\n\n' +
          'Synthesize into final recommendation:\n\n' +
          '{\n' +
          '  "conclusion_type": "strong_recommend|same_tier|insufficient_data",\n' +
          '  "confidence": "high|medium|low",\n' +
          '  "headline": "1-2 sentence bottom line",\n' +
          '  "adjusted_ranking": [\n' +
          '    {"rank": 1, "option": "name", "utility_mean": <from sim_results>, "adjustment_note": "reason for any adjustment"}\n' +
          '  ],\n' +
          '  "challenges_addressed": [\n' +
          '    {"challenge_id": "DEVIL-001", "resolution": "how addressed", "score_impact": "none|minor|moderate"}\n' +
          '  ],\n' +
          '  "forward_adjustments": [\n' +
          '    {"module": "name", "impact_on_ranking": "description"}\n' +
          '  ],\n' +
          '  "tradeoff_narrative": "if close: key tradeoff and what determines the right choice",\n' +
          '  "action_items": [\n' +
          '    {"priority": 1, "action": "specific action", "deadline": "when", "reason": "why"}\n' +
          '  ],\n' +
          '  "report_markdown": "FULL report in Markdown..."\n' +
          '}\n\n' +
          'The report_markdown MUST include:\n' +
          '# Decision Report\n' +
          '## Recommendation (type + headline + confidence)\n' +
          '## Ranking (utility means, std, P10/P90 from sim_results.per_option)\n' +
          '## Scenario Stress Test (per-scenario utility per option from sim_results.per_option[*].per_scenario)\n' +
          '## Sensitivity (cite sim_results.sensitivity entries — which perturbations flip the ranking)\n' +
          '## Key Tradeoffs (if same_tier)\n' +
          '## Forward Outlook (SAGE per option)\n' +
          '## Challenges Addressed (DEVIL + resolutions)\n' +
          '## Action Items (numbered, deadline-aware)\n\n' +
          'Use REAL numbers from sim_results everywhere. Do not invent statistics.\n' +
          'Return ONLY the JSON.'
      }
    ]
  };
}

// ── 9. MIRROR ────────────────────────────────────────────

function buildMirrorPrompt(allData, ps) {
  var fw = ps.framework || {};
  var or = ps.oracle || {};
  var ec = ps.echo || {};
  var sr = ps.sim_results || {};
  var ip = ps.interpret || {};
  var de = ps.devil || {};
  var sa = ps.sage || {};
  var nx = ps.nexus || {};

  var avgConf = 0;
  var orOpts = or.options || [];
  if (orOpts.length) {
    avgConf = orOpts.reduce(function(s, o) { return s + (o.data_confidence || 0); }, 0) / orOpts.length;
  }

  return {
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: 'You are MIRROR, the process reviewer. Review the entire analysis quality. Be brief and honest — 5-8 key points max.\n\nReturn ONLY a valid JSON object.'
      },
      {
        role: 'user',
        content: '## Pipeline Summary\n' +
          '- Framework: ' + (fw.evaluation_dimensions || []).length + ' dimensions, ' + (fw.scenarios || []).length + ' scenarios\n' +
          '- ORACLE: ' + orOpts.length + ' options, avg confidence ' + avgConf.toFixed(2) + '\n' +
          '- ECHO: ' + (ec.options || []).length + ' options covered\n' +
          '- SIMULATE: ' + (sr.n_iterations || '?') + ' iterations, stability ' + (sr.ranking_stability || '?') + ', ' + (sr.rank_flip_count || 0) + ' rank flips in sensitivity\n' +
          '- INTERPRET conclusion: ' + (ip.conclusion_type || '?') + '\n' +
          '- DEVIL: ' + (de.challenges || []).length + ' challenges (' + (de.challenges || []).filter(function(c) { return c.severity === 'critical'; }).length + ' critical)\n' +
          '- SAGE: ' + (sa.modules || []).length + ' modules scored\n' +
          '- NEXUS: ' + (nx.conclusion_type || '?') + ', confidence: ' + (nx.confidence || '?') + '\n\n---\n\n' +
          '{\n' +
          '  "information_completeness": {"score": 8, "assessment": "which options had strong/weak data"},\n' +
          '  "framework_quality": {"score": 7, "assessment": "were dimensions/scenarios appropriate?"},\n' +
          '  "prior_quality": {"score": 7, "assessment": "were the simulation priors (distributions, weights) reasonable?"},\n' +
          '  "biggest_blind_spot": "most important thing possibly missed",\n' +
          '  "weakest_link": "which step was least reliable and why",\n' +
          '  "strongest_link": "which step was most valuable",\n' +
          '  "if_redo_one_thing": "what to change",\n' +
          '  "overall_confidence": {"level": "high|medium|low", "justification": "one sentence"},\n' +
          '  "user_should_verify": ["things to check before deciding"]\n' +
          '}\n\n' +
          'Be honest and concise. Return ONLY the JSON.'
      }
    ]
  };
}
