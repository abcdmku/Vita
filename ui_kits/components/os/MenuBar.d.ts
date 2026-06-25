import * as React from 'react';
/** Global desktop menu bar — Vita.ts brand, app menus, and a Lucide status cluster (wifi / battery / clock). */
export interface MenuBarProps { menus?: string[]; time?: string; }
export function MenuBar(props: MenuBarProps): JSX.Element;
