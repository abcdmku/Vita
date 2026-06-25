import * as React from 'react';
export interface CommandResult { icon?: string; title?: string; sub?: string; enter?: boolean; }
/**
 * The ⌘K launcher — search field over a translucent panel of command/app/file results. Render screen-centered.
 * @startingPoint section="OS" subtitle="⌘K command launcher" viewport="720x440"
 */
export interface CommandPaletteProps { query?: string; placeholder?: string; results?: CommandResult[]; width?: number; }
export function CommandPalette(props: CommandPaletteProps): JSX.Element;
