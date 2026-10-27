export const MODES = ['bus', 'metro', 'rail', 'tram', 'boat'] as const;
export type Mode = typeof MODES[number];
export const MODE_NAMES: Record<Mode, string> = { bus: 'Buss', metro: 'Tunnelbana', rail: 'Pendeltåg', tram: 'Spårvagn / lokalbana', boat: 'Båt' };
export interface Stop { id: string; name: string; lat: number; lon: number; station: string; platform: string; retired?: boolean; scheduled?:boolean; walking?: 'available' | 'estimated' | 'missing'; walkingArea?: boolean }
export interface Route { id: string; name: string; mode: Mode; shortName?:string; description?:string; agencyId?:string; color?:string; textColor?:string }
export interface Connection { from: number; to: number; departure: number; arrival: number; trip: string; route: number; sequence: number; pickup: boolean; dropoff: boolean; pickupRequest?: boolean; dropoffRequest?: boolean }
export interface Walk { from: number; to: number; seconds: number; source: string; metres?: number; path?:[number,number][] }
export interface TransferRule { from: number; to: number; type: 0 | 1 | 2 | 3; seconds: number; fromTrip?: string; toTrip?: string; fromRoute?: string; toRoute?: string }
export interface WalkingClosureTable { readonly maxSeconds:number; readonly pairs:number; begin(stop:number):number; end(stop:number):number; destination(entry:number):number; seconds(entry:number):number; path(from:number,to:number):Walk[] }
export interface Network { stops: Stop[]; routes: Route[]; connections: Connection[]; walks: Walk[]; transfers: TransferRule[]; walkingClosure?:WalkingClosureTable }
export interface FootpathAnchor {from:number;to:number;t:number}
export interface OriginAccess { anchor?:FootpathAnchor;lat:number; lon:number; snapMetres:number; walks:{to:number;seconds:number;metres:number;path:[number,number][]}[] }
export interface Settings { direction?: 'arrive'; origin?: 'point'; displayMinutes?: number; v: 1; stop: string; name: string; lat: number; lon: number; date: string; time: string; maxMinutes: number; walkMinutes: number; modes: Mode[]; maxTransfers: number; windowMinutes: number }
export interface JourneyLeg { path?:[number,number][]; kind: 'walk' | 'transit'; from: number; to: number; departure: number; arrival: number; stops: number[]; route?: number; requestStop?: boolean; metres?: number; estimated?: boolean }
export interface JourneyNode extends JourneyLeg { previous: number | null }
export interface Reach { seconds: number; kind: 'walk' | 'transit'; arrival: number; boardings: number; requestStop?: boolean; journey: number | null }
export interface WalkSource { stop: number; seconds: number; walked: number }
export interface DestinationSource extends WalkSource { arrival:number;boardings:number;journey:number|null;requestStop?:boolean }
export interface PointJourney { destination:{lat:number;lon:number;snapMetres:number};source:DestinationSource;value:Reach;legs:JourneyLeg[] }
export interface SearchResult { reverseEpoch?:number; destinationSources?:DestinationSource[]; origin?:{lat:number;lon:number;snapMetres:number;anchor?:FootpathAnchor}; values: (Reach | null)[]; journeys: JourneyNode[]; routes: Route[]; walkSources: WalkSource[]; labels: number; elapsed: number; complete: true }
export interface StationProgress { completedRounds: number; totalRounds: number; processedLabels: number; queuedLabels: number; changes: { stop: number; value: Reach }[] }
export interface FileRef { url: string; sha256: string; bytes: number }
export interface ContourFiles { format?: 'sliso-contours-v1'; index: Record<string, number>; files: FileRef[] }
export interface Manifest {
  sourceVersion?: string; sourceUpdated?: string | null;
  schema: 2; version: string; demo: boolean; updated: string; validFrom: string; validTo: string;
  walkingMaxMinutes: number; walkingVersion: string; walkingSpeedKmh: number;
  transferWalking?: {policy:string;eligibleRows:number;addedLinks:number;existingComponent:number;rejectedCost:number};
  walkingCoverage?: { totalStops: number; boundStops: number; pairs: number; reviewed: boolean };
  waterMask?: {format:'sliso-water-bitmap-v1';tileDegrees:number;resolution:number;tiles:Record<string,FileRef>};
  walkingAreas?: ContourFiles & { stepMinutes: 1; sources?: Record<string, number>; overview?: ContourFiles & {stepMinutes:5}; reviewed: boolean };
  stops: FileRef; walks: FileRef; routes: FileRef; transfers: FileRef;
  footpaths?: {format:'sliso-footpaths-v1';tileDegrees:number;sourceVersion:string;index:Record<string,FileRef>};
  walkingClosure?: FileRef & {format:'sliso-walk-closure-v1';maxMinutes:number};
  trips: FileRef; days: Record<string, (FileRef & { from: number; until: number })[]>; warnings: string[]; attribution: string[];
}
