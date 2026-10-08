export type { EditorParagraph } from './document';
export { chapterExtensions, fromDoc, toDoc } from './document';
export type { ParagraphIdentityOptions, SourceKind, StructuralLog } from './paragraph-identity';
export { ParagraphIdentity, paragraphIdentityKey, structuralLog } from './paragraph-identity';
export type { EntityHighlightOptions } from './entity-highlight';
export { EntityHighlight, entityHighlightKey, setHighlightEntities } from './entity-highlight';
export type { EntityMatch, MatchableEntity } from './entity-matcher';
export { createEntityMatcher, MIN_MATCH_LENGTH } from './entity-matcher';
