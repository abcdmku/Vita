import * as React from 'react';
/** Inline 2–4 option switch (theme, view mode). For longer lists use Select. */
export interface SegmentedControlProps { options?: string[]; value?: string; onChange?: (value: string) => void; }
export function SegmentedControl(props: SegmentedControlProps): JSX.Element;
