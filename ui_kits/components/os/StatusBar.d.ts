import * as React from 'react';
/** Tiling-mode status bar — workspace pills, current path, git branch and cursor/clock info. */
export interface StatusBarProps { workspaces?: number; active?: number; path?: string; info?: string; branch?: string; }
export function StatusBar(props: StatusBarProps): JSX.Element;
