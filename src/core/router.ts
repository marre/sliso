import {isPublicStop} from './stops';
import {profileStart,profileEnd} from './profile';
import type { DestinationSource, OriginAccess, Connection, JourneyNode, Network, Reach, SearchResult, Settings, TransferRule, Walk, WalkSource, StationProgress } from './types';
import { stockholmInstant } from './time';
import { validateSettings } from './settings';
interface TransferContext {
  ready: number; pending: number; threshold: number; blocked: boolean;
}
interface Label {
  context?: TransferContext; settled?: boolean; active?: boolean;
  stop: number; time: number; anchor: number | null; walk: number; boardings: number;
  requestStop: boolean; lastTrip: string; lastRoute: string; alightStop: number; alightTime: number;
  previous: Label | null; via: Connection | Walk | null; alight: Connection | null;
}
function baseTrip(id: string): string { return /^\d{4}-\d{2}-\d{2}:/.test(id) ? id.slice(11) : id; }
function applicable(r: TransferRule, l: Label, c: Connection, network: Network): boolean {
  return r.from === l.alightStop && r.to === c.from && (!r.fromTrip || (r.fromTrip === l.lastTrip || r.fromTrip === baseTrip(l.lastTrip))) && (!r.toTrip || (r.toTrip === c.trip || r.toTrip === baseTrip(c.trip))) && (!r.fromRoute || r.fromRoute === l.lastRoute) && (!r.toRoute || r.toRoute === network.routes[c.route].id);
}
export function canTransfer(l: Label, c: Connection, network: Network, candidates = network.transfers): boolean {
  if (!l.boardings) return true;
  const rules = candidates.filter(r => applicable(r, l, c, network));
  // Trip-specific rules supersede route-specific rules, which supersede stop-only rules.
  const rank = (r: TransferRule) => (r.fromTrip ? 4 : 0) + (r.toTrip ? 4 : 0) + (r.fromRoute ? 1 : 0) + (r.toRoute ? 1 : 0);
  const best = Math.max(-1, ...rules.map(rank));
  return rules.filter(r => rank(r) === best).every(r => r.type !== 3 && c.departure >= l.alightTime + r.seconds);
}
/** Round-based route-pattern scanner. Retains time AND displayed-cost alternatives. No heuristic truncation.
 * Each boarding follows the whole trip; staying seated never requires a legal alight/reboard.
 * Distinct GTFS trips count as distinct vehicles (conservative; block_id is not continuity proof).
 */
export function search(network: Network, settings: Settings, options: { fixedAnchor?:boolean; destinationJourneys?:boolean; access?:OriginAccess; prune?: boolean; maxLabels?: number; onProgress?: (progress: StationProgress) => void } = {}): SearchResult {
  const indexing=profileStart();
  validateSettings(settings);
  const started = performance.now(), t0 = stockholmInstant(settings.date, settings.time);
  const start = network.stops.findIndex(s => s.id === settings.stop);
  if (settings.origin==='point'&&!options.access)throw new Error('Gånganslutningen från kartpunkten saknas.');
  if (start < 0&&settings.origin!=='point') throw new Error('Starthållplatsen saknas i datan. Välj en ersättare.');
  const max = settings.maxMinutes * 60, maxWalk = settings.walkMinutes * 60;
  const closure=network.walkingClosure&&network.walkingClosure.maxSeconds>=maxWalk?network.walkingClosure:undefined;
  const windowEnd = t0 + settings.windowMinutes * 60, latest = windowEnd + max;
  const walking = network.stops.map(() => [] as Network['walks']);
  const trips = new Map<string, Connection[]>();
  for (const c of network.connections) {
    if (c.departure < t0 || c.departure > latest) continue;
    const trip = trips.get(c.trip) ?? []; trip.push(c); trips.set(c.trip, trip);
  }
  for (const a of trips.values()) a.sort((a,b) => a.sequence - b.sequence);
  if(!closure)for (const w of network.walks) walking[w.from].push(w);
  const ruleIndex = new Map<string, TransferRule[]>();
  const tripSpecific = new Set<string>();
  const transferDelay = network.stops.map(() => 0);
  const transferBlocked = new Set<number>();
  const routeSpecific = network.transfers.some(r => r.fromRoute);
  for (const r of network.transfers) {
    transferDelay[r.from] = Math.max(transferDelay[r.from], r.seconds);
    if (r.type === 3) transferBlocked.add(r.from);
    const key = `${r.from}|${r.to}`;
    const list = ruleIndex.get(key) ?? []; list.push(r); ruleIndex.set(key,list);
    if (r.fromTrip) tripSpecific.add(r.fromTrip);
  }
  // Once every minimum transfer time from an alighting event has elapsed,
  // its stop/time cannot restrict any future boarding. Forget only that spent
  // context, retaining trip/route distinctions and all prohibited transfers.
  const groupIds = new Map<string, number>();
  function group(key: string): number {
    let id = groupIds.get(key);
    if (id === undefined) {
      id = groupIds.size;
      // Numeric (context, stop) keys must remain collision-free integers.
      if (!Number.isSafeInteger((id + 1) * network.stops.length)) throw new Error('För stort nät för exakta kontextnycklar.');
      groupIds.set(key, id);
    }
    return id;
  }
  function prepareContext(l: Label): TransferContext {
    if (l.context) return l.context;
    const trip = (tripSpecific.has(l.lastTrip) || tripSpecific.has(baseTrip(l.lastTrip))) ? l.lastTrip : '*';
    const prefix = JSON.stringify([l.boardings, trip, routeSpecific ? l.lastRoute : '*']);
    // Walking inherits this immutable alighting context. No string/regex work
    // is needed when relaxing a walking edge or checking queued membership.
    return l.context = { ready: group(prefix + '|*'), pending: group(prefix + '|' + l.alightStop), threshold: l.alightTime + transferDelay[l.alightStop], blocked: transferBlocked.has(l.alightStop) };
  }
  const values: (Reach | null)[] = network.stops.map(() => null);
  const witnesses: (Label | null)[] = network.stops.map(() => null);
  const finalWalking: WalkSource[][] = network.stops.map(() => []);
  const queues: Label[][] = Array.from({length: settings.maxTransfers+2},()=>[]);
  let labels=0, processed=0, lastProgress=performance.now();
  const changes=new Map<number,Reach>();
  function report(completedRounds: number) {
    if (!options.onProgress) return;
    options.onProgress({completedRounds,totalRounds:queues.length,processedLabels:processed,queuedLabels:labels,changes:[...changes].map(([stop,value])=>({stop,value:{...value}}))});
    changes.clear(); lastProgress=performance.now();
  }
  const frontiers = new Map<number, Label[]>();
  function cost(l: Label): number { return l.time - (l.anchor ?? t0); }
  function push(l: Label): void {
    if (cost(l) > max || l.walk > maxWalk || l.time > latest) return;
    const old = values[l.stop], seconds = cost(l);
    if (network.stops[l.stop].walkingArea && seconds < max && l.walk < maxWalk) {
      const list = finalWalking[l.stop];
      if (!list.some(a => a.seconds <= seconds && a.walked <= l.walk)) {
        finalWalking[l.stop] = [...list.filter(a => !(seconds <= a.seconds && l.walk <= a.walked)), { stop: l.stop, seconds, walked: l.walk }];
      }
    }
    if (!old || seconds < old.seconds || (seconds === old.seconds && (l.time < old.arrival || (l.time === old.arrival && l.boardings < old.boardings)))) {
      values[l.stop] = { seconds, arrival: l.time, kind: l.boardings ? 'transit' : 'walk', boardings: l.boardings, requestStop: l.requestStop, journey: null };
      witnesses[l.stop] = l;
      if(options.onProgress)changes.set(l.stop,values[l.stop]!);
    }
    // Context must match: transfer constraints refer to the actual previous trip/alighting event.
    const context = prepareContext(l);
    l.settled = !context.blocked && l.time >= context.threshold;
    l.active = true;
    const key = (l.settled ? context.ready : context.pending) * network.stops.length + l.stop;
    const list = frontiers.get(key) ?? [];
    const dominates = (a: Label, b: Label) => a.time <= b.time && (a.settled && b.settled || a.alightTime <= b.alightTime) && a.walk <= b.walk && (a.anchor ?? t0) >= (b.anchor ?? t0);
    if (options.prune !== false && list.some(a => dominates(a, l))) return;
    frontiers.set(key, [...list.filter(a => {
      if (dominates(l, a)) { a.active = false; return false; }
      return true;
    }), l]); queues[l.boardings].push(l);labels++;
    if (labels > (options.maxLabels ?? 2_000_000)) throw new Error('Beräkningen överskred minnesbudgeten. Resultatet är ofärdigt; begränsa sökningen.');
  }
  const root:Label={stop:settings.origin==='point'?network.stops.length:start,time:t0,anchor:options.fixedAnchor?t0:null,walk:0,boardings:0,requestStop:false,lastTrip:'',lastRoute:'',alightStop:start,alightTime:t0,previous:null,via:null,alight:null};
  if(settings.origin==='point'){
    for(const access of options.access!.walks){
      if(!network.stops[access.to]||!Number.isFinite(access.seconds)||access.seconds<0)throw new Error('Ogiltig gånganslutning.');
      push({...root,stop:access.to,time:t0+access.seconds,walk:access.seconds,alightStop:access.to,previous:root,via:{from:root.stop,to:access.to,seconds:access.seconds,metres:access.metres,source:'Mapped origin access',path:access.path}});
    }
  }else push(root);
  report(0);
  profileEnd('routing.index',indexing);
  const patternsStarted=profileStart();
  // A route pattern has the same route and ordered connection endpoints/sequences.
  // Trips can overtake: retain a separate onboard state for every trip instance.
  // Never choose just the earliest departure and discard later, shorter-cost anchors.
  interface Pattern { trips: Connection[][] }
  const patterns=new Map<string,Pattern>(),atStop: Set<Pattern>[]=network.stops.map(()=>new Set());
  for(const trip of trips.values()){
    const key=JSON.stringify([trip[0].route,trip.map(c=>[c.from,c.to,c.sequence])]);
    let pattern=patterns.get(key);
    if(!pattern){pattern={trips:[]};patterns.set(key,pattern);for(const c of trip)atStop[c.from].add(pattern);}
    pattern.trips.push(trip);
  }
  profileEnd('routing.patterns',patternsStarted,{patterns:patterns.size,trips:trips.size});
  for(let round=0;round<queues.length;round++){
    let stage=profileStart();
    const queue=queues[round];
    // Complete the continuous-walking closure before scanning vehicle routes.
    for(let head=0;head<queue.length;head++){
      const l=queue[head];processed++;
      if(options.onProgress&&(processed&127)===0&&performance.now()-lastProgress>=100)report(round);
      if(options.prune!==false&&!l.active)continue;
      // The complete table expands a whole walking leg from its origin or
      // alighting event. Walking-reached labels still participate in boarding.
      if(closure&&l.via&&'seconds' in l.via&&!l.via.path)continue;
      const context = l.context!;
      const first=closure?closure.begin(l.stop):0,until=closure?closure.end(l.stop):walking[l.stop].length;
      for(let entry=first;entry<until;entry++){
        const to=closure?closure.destination(entry):walking[l.stop][entry].to,seconds=closure?closure.seconds(entry):walking[l.stop][entry].seconds;
        const time=l.time+seconds,walk=l.walk+seconds;
        if(time-(l.anchor??t0)>max||walk>maxWalk||time>latest)continue;
        const settled=!context.blocked&&time>=context.threshold;
        const key=(settled?context.ready:context.pending)*network.stops.length+to;
        // A retained dominator has already contributed an equal/better stop
        // value AND walking frontier. Reject before allocating a candidate.
        if(options.prune!==false&&frontiers.get(key)?.some(a=>a.time<=time&&(a.settled&&settled||a.alightTime<=l.alightTime)&&a.walk<=walk&&(a.anchor??t0)>=(l.anchor??t0)))continue;
        const via:Walk=closure?{from:l.stop,to,seconds,source:'precomputed'}:walking[l.stop][entry];
        push({...l,stop:to,time,walk,previous:l,via,alight:null});
      }
    }
    profileEnd('routing.walkClosure',stage,{round,labels:queue.length,precomputed:!!closure});stage=profileStart();
    if(round<queues.length-1){
      const active:Label[][]=network.stops.map(()=>[]),marked=new Set<Pattern>();
      for(const l of queue){
        if(options.prune!==false&&!l.active)continue;
        active[l.stop].push(l);for(const p of atStop[l.stop])marked.add(p);
      }
      for(const pattern of marked){
        if(!settings.modes.includes(network.routes[pattern.trips[0][0].route].mode))continue;
        const onboard:({label:Label;boarding:Connection;anchor:number}|undefined)[]=Array(pattern.trips.length);
        for(let position=0;position<pattern.trips[0].length;position++){
          for(let t=0;t<pattern.trips.length;t++){
            const c=pattern.trips[t][position];processed++;
            if(options.onProgress&&(processed&127)===0&&performance.now()-lastProgress>=100)report(round);
            if(c.pickup)for(const l of active[c.from]){
              if(c.departure<l.time||(!round&&c.departure>windowEnd)||l.lastTrip===c.trip)continue;
              const anchor=l.anchor??c.departure-l.walk;
              if(c.departure-anchor>max||(onboard[t]&&onboard[t]!.anchor>=anchor))continue;
              if(!canTransfer(l,c,network,ruleIndex.get(`${l.alightStop}|${c.from}`)??[]))continue;
              onboard[t]={label:l,boarding:c,anchor};
            }
            const state=onboard[t];if(!state||!c.dropoff||c.arrival-state.anchor>max)continue;
            push({stop:c.to,time:c.arrival,anchor:state.anchor,walk:0,boardings:round+1,requestStop:state.label.requestStop||!!state.boarding.pickupRequest||!!c.dropoffRequest,lastTrip:c.trip,lastRoute:network.routes[c.route].id,alightStop:c.to,alightTime:c.arrival,previous:state.label,via:state.boarding,alight:c});
          }
        }
      }
    }
    profileEnd('routing.routeScan',stage,{round});
    report(round+1);
  }
  // Serialize only the predecessor chains that actually explain a displayed value.
  // Shared nodes avoid copying a complete itinerary for every reachable destination.
  const serialization=profileStart();
  const journeys: JourneyNode[] = [], ids = new Map<Label, number>();
  function serialize(witness:Label|null):number|null {
    if (!witness?.previous) return null;
    const pending: Label[] = [];
    for (let l: Label | null = witness; l?.previous && !ids.has(l); l = l.previous) pending.push(l);
    while (pending.length) {
      const l = pending.pop()!, via = l.via!, previous = ids.get(l.previous!) ?? null;
      let node: JourneyNode;
      if ('seconds' in via) {
        if(closure&&!via.path){
          let predecessor=previous,time=l.previous!.time;
          for(const edge of closure.path(via.from,via.to)){
            node={previous:predecessor,kind:'walk',from:edge.from,to:edge.to,departure:time,arrival:time+edge.seconds,stops:[edge.from,edge.to],metres:edge.metres,estimated:edge.source.startsWith('Assumed ')||undefined};
            time+=edge.seconds;predecessor=journeys.length;journeys.push(node);
          }
          ids.set(l,predecessor!);continue;
        }
        node = { previous, kind: 'walk', from: via.from, to: via.to, departure: l.previous!.time, arrival: l.time, stops: [via.from, via.to], ...(via.path?{path:via.path}:{}), metres: via.metres, estimated: via.source.startsWith('Assumed ') || undefined };
      } else {
        const path = trips.get(via.trip)!.filter(c => c.sequence >= via.sequence && c.sequence <= l.alight!.sequence);
        node = { previous, kind: 'transit', from: via.from, to: l.stop, departure: via.departure, arrival: l.time, route: via.route, stops: [via.from, ...path.map(c => c.to)], requestStop: !!via.pickupRequest || !!l.alight!.dropoffRequest };
      }
      ids.set(l, journeys.length); journeys.push(node);
    }
    return ids.get(witness)!;
  }
  witnesses.forEach((witness,stop)=>{if(values[stop])values[stop]!.journey=serialize(witness);});
  let destinationSources:DestinationSource[]|undefined;
  if(options.destinationJourneys){
    // Existing routing dominance is stronger than terminal-walk dominance.
    // Reuse the surviving labels once, without bookkeeping on every relaxation.
    const eligible=network.stops.map(isPublicStop),terminal:Label[][]=network.stops.map(()=>[]);
    const dominates=(a:Label,b:Label)=>a.walk<=b.walk&&(cost(a)<cost(b)||(cost(a)===cost(b)&&(a.time<b.time||(a.time===b.time&&a.boardings<=b.boardings))));
    for(const list of frontiers.values())for(const l of list){
      if(!l.active||!eligible[l.stop])continue;
      const row=terminal[l.stop];if(row.some(a=>dominates(a,l)))continue;
      terminal[l.stop]=[...row.filter(a=>!dominates(l,a)),l];
    }
    destinationSources=terminal.flatMap(row=>row.map(l=>({stop:l.stop,seconds:cost(l),walked:l.walk,arrival:l.time,boardings:l.boardings,journey:serialize(l),requestStop:l.requestStop||undefined})));
  }
  profileEnd('routing.journeys',serialization,{nodes:journeys.length,labels});
  return { ...(destinationSources?{destinationSources}:{}), ...(options.access?.directWalking?{directWalking:options.access.directWalking}:{}), ...(options.access?{origin:{lat:options.access.lat,lon:options.access.lon,snapMetres:options.access.snapMetres,...(options.access.anchor?{anchor:options.access.anchor}:{})}}:{}), values, journeys, routes: network.routes, walkSources: finalWalking.flat(), labels, elapsed: performance.now() - started, complete: true };
}
