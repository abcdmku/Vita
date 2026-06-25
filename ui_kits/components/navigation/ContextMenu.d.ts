import * as React from 'react';
export interface MenuItem { icon?: string; label?: string; shortcut?: string; danger?: boolean; separator?: boolean; }
/** Right-click / overflow menu. Translucent, with leading Lucide icons + shortcuts. */
export interface ContextMenuProps { items?: MenuItem[]; width?: number; }
export function ContextMenu(props: ContextMenuProps): JSX.Element;
