import * as React from 'react';
/** Removable token chip — file types, filters, tags. Monospace by default. */
export interface TagProps { children?: React.ReactNode; mono?: boolean; onRemove?: () => void; }
export function Tag(props: TagProps): JSX.Element;
