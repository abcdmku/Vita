import * as React from 'react';
/** Versatile list item for Settings, sidebars and the file tree. `icon` is a Lucide name; use `indent` for tree depth. */
export interface ListRowProps { icon?: string; title?: React.ReactNode; subtitle?: React.ReactNode; trailing?: React.ReactNode; indent?: number; active?: boolean; onClick?: () => void; }
export function ListRow(props: ListRowProps): JSX.Element;
