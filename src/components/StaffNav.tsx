import { NavLink } from 'react-router-dom';

import { useAuth } from '../features/auth/AuthContext';
import { Badge } from './Badge';

const allItems: Array<{ to: string; label: string; badge?: string }> = [
  { to: '/moyasser/dashboard', label: 'الرئيسية' },
  { to: '/moyasser/reports', label: 'التقارير' },
  { to: '/moyasser/students', label: 'الطلاب' },
  { to: '/moyasser/grades', label: 'الصفوف' },
  { to: '/moyasser/curriculum', label: 'المنهج' },
  { to: '/moyasser/exams', label: 'الإختبارات' },
  { to: '/moyasser/pricing', label: 'أسعار الوحدات' },
  { to: '/moyasser/codes', label: 'أكواد الوحدات' },
  { to: '/moyasser/announcements', label: 'الإعلانات', badge: 'جديد' },
];

const assistantItems: Array<{ to: string; label: string; badge?: string }> = [
  { to: '/moyasser/curriculum', label: 'المنهج' },
  { to: '/moyasser/exams', label: 'الإختبارات' },
];

export function StaffNav() {
  const { role } = useAuth();
  const items = role === 'assistant' ? assistantItems : allItems;
  return (
    <nav aria-label="التنقل الرئيسي" className="flex flex-col gap-1 p-3">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/moyasser/dashboard'}
          className={({ isActive }) =>
            `rounded-xl px-3 py-3 text-sm font-bold transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              isActive
                ? 'nav-pill-active text-white shadow-[0_8px_20px_-8px_rgba(99,102,241,0.5)]'
                : 'text-foreground-muted hover:bg-white/6 hover:text-foreground hover:translate-x-0.5'
            }`
          }
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span>{item.label}</span>
            {item.badge ? (
              <Badge variant="success" className="shrink-0 px-1.5 py-0 text-[10px] font-bold leading-5">
                {item.badge}
              </Badge>
            ) : null}
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
