import { clampOptions, type Options } from './engine';
import { scoreCandidate } from './relevance';

export interface ExplorationPolicy {
  focused: boolean;
  /** Number of link hops from a source attached directly to the seed. */
  depthCap: number;
  breadth: number;
  priority: number;
}

/** Rule weights also determine which supplemental terms receive the bounded
 * public search queries. They never increase the existing request budget. */
export function explorationDirectionTerms(raw: Options): string[] {
  return directionTerms(clampOptions(raw));
}
function directionTerms(options: Options): string[] {
  const rules = [...(options.directionRules ?? [])].sort((a,b) => b.weight - a.weight);
  return [...new Set([...rules.map(rule => rule.term), ...options.searchTerms])];
}

/** Deterministic lexical allocation, not a semantic relevance claim. The
 * configured depth/link limits remain ceilings under every strategy. */
export function explorationPolicy(title: string, context: string, distance: number, raw: Options, center = ''): ExplorationPolicy {
  const options = clampOptions(raw), hop = Math.max(0, Math.floor(distance));
  const strategy = options.explorationStrategy ?? 'radial', directions = directionTerms(options);
  const directional = directions.length > 0;
  const rank = scoreCandidate('', title, context, { searchTerms: directions, relevance: 'balanced' });
  // Center context occurs in nearly every link quotation on a seed page. Use
  // the candidate title for center focus so a surrounding sentence cannot
  // allocate full depth to every incidental institution, person or location.
  const centerRank = strategy === 'focused' ? scoreCandidate(center, title, '', {relevance:'balanced'}) : {score:0};
  const focused = directional && rank.score >= 3 || centerRank.score >= 3;
  const matchedRule = (options.directionRules ?? []).map(rule => ({rule, score:scoreCandidate('', title, context, {searchTerms:[rule.term],relevance:'balanced'}).score}))
    .filter(item => item.score >= 3).sort((a,b) => b.score * b.rule.weight - a.score * a.rule.weight)[0];
  const weight = matchedRule?.rule.weight ?? 1;
  let depthCap = !directional || focused ? options.depth : Math.min(options.depth, Math.max(1, Math.floor(options.depth / 2)));
  let decay = 1, factor = !directional ? 1 : focused ? 1.5 : 0.5;
  if (strategy === 'focused') {
    depthCap = focused ? options.depth : Math.min(options.depth, Math.max(1, Math.floor(options.depth / 3)));
    decay = focused ? 0.5 : 1;
    factor = hop === 0 ? 1 : focused ? 0.75 : 0.2;
  } else if (strategy === 'breadth' || strategy === 'depth') { depthCap = options.depth; decay = 0; factor = 1; }
  else if (strategy === 'custom') {
    depthCap = Math.min(options.depth, (options.offDirectionDepth ?? 1) + (focused ? options.directionDepthBoost ?? 2 : 0));
    decay = options.breadthDecay ?? 1; factor = 1;
    // Read the entry source far enough to expose the first ring even when
    // off-direction descendants are configured to stop immediately.
    if (hop === 0 && options.depth > 0) depthCap = Math.max(1, depthCap);
  }
  if (matchedRule?.rule.depth !== undefined && (hop > 0 || scoreCandidate('',title,'',{searchTerms:[matchedRule.rule.term],relevance:'balanced'}).score >= 3))
    depthCap = Math.min(options.depth, matchedRule.rule.depth);
  const limit = strategy === 'depth' ? Math.min(3, options.linkLimit) : options.linkLimit;
  const breadth = limit === 0 ? 0 : Math.min(limit, Math.max(1, Math.floor(limit * factor / Math.pow(hop + 1, decay))));
  const score = Math.max(rank.score, centerRank.score, (matchedRule?.score ?? 0) * weight);
  return { focused, depthCap, breadth, priority: (focused ? 30 * weight + score : score) / Math.pow(hop + 1, strategy === 'focused' || strategy === 'custom' ? 0.5 : 1) };
}

/** Stable bounded-frontier order. A depth strategy actually follows chains;
 * focusing favors matched branches before unrelated branches at shallow hops. */
export function compareExplorationWork(a: {distance:number;priority:number;sequence:number}, b: {distance:number;priority:number;sequence:number}, options: Options): number {
  if (options.explorationStrategy === 'depth') return b.distance - a.distance || b.priority - a.priority || a.sequence - b.sequence;
  if (options.explorationStrategy === 'focused' || options.explorationStrategy === 'custom')
    return b.priority - a.priority || a.distance - b.distance || a.sequence - b.sequence;
  return a.distance - b.distance || b.priority - a.priority || a.sequence - b.sequence;
}
