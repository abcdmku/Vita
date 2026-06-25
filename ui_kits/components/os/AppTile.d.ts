import * as React from 'react';
/** A single app icon — a Lucide glyph on a rounded tile, with an active dot. */
export interface AppTileProps { icon?: string; active?: boolean; size?: number; label?: string; }
export function AppTile(props: AppTileProps): JSX.Element;
