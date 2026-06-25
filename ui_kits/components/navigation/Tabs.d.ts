import * as React from 'react';
/** Underline tab bar for switching panes within a window. */
export interface TabsProps { tabs?: string[]; value?: string; onChange?: (tab: string) => void; }
export function Tabs(props: TabsProps): JSX.Element;
