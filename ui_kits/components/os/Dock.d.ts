import * as React from 'react';
export interface DockApp { icon: string; active?: boolean; }
export interface DockProps { apps?: DockApp[]; settings?: boolean; }
export function Dock(props: DockProps): JSX.Element;
