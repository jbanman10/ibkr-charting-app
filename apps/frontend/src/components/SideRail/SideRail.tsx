import type { ReactNode } from 'react';
import styles from './SideRail.module.css';

// A persistent vertical bar on the right edge holding quick-toggle tools. Add
// more entries to the `items` array as features land (alerts, screeners, etc.).
export interface RailItem {
  id: string;
  title: string;
  icon: ReactNode;
  active?: boolean;
  onClick: () => void;
}

export default function SideRail({ items }: { items: RailItem[] }) {
  return (
    <nav className={styles.rail} aria-label="Tools">
      {items.map((it) => (
        <button
          key={it.id}
          className={`${styles.btn} ${it.active ? styles.btnActive : ''}`}
          onClick={it.onClick}
          title={it.title}
          aria-label={it.title}
          aria-pressed={it.active ?? false}
        >
          {it.icon}
        </button>
      ))}
    </nav>
  );
}
