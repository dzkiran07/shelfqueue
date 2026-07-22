import { useEffect, useRef, useState } from 'react';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function toISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseISO(value) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameDay(a, b) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function buildMonthGrid(viewDate) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startOffset);

  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    cells.push(cellDate);
  }
  return cells;
}

export default function DatePicker({ id, label, value, onChange, describedBy }) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => parseISO(value) || new Date());
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);

  function closePicker() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  const selected = parseISO(value);
  const today = new Date();

  useEffect(() => {
    if (!open) return undefined;
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') closePicker();
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function openPicker() {
    setViewDate(selected || new Date());
    setOpen(true);
  }

  function pickDay(day) {
    onChange(toISO(day));
    closePicker();
  }

  function changeMonth(delta) {
    setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  }

  const cells = buildMonthGrid(viewDate);
  const displayLabel = selected
    ? `${MONTH_NAMES[selected.getMonth()].slice(0, 3)} ${selected.getDate()}, ${selected.getFullYear()}`
    : 'mm/dd/yyyy';

  return (
    <div className="date-picker" ref={wrapperRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={`date-picker-trigger${selected ? '' : ' is-placeholder'}`}
        onClick={() => (open ? closePicker() : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={describedBy}
      >
        <span>{displayLabel}</span>
        <span className="date-picker-icon" aria-hidden="true">
          <span />
        </span>
      </button>

      {open ? (
        <div className="date-picker-popover" role="dialog" aria-label={label ? `Choose ${label} date` : 'Choose a date'}>
          <div className="date-picker-header">
            <button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}>
              ‹
            </button>
            <span>
              {MONTH_NAMES[viewDate.getMonth()]} {viewDate.getFullYear()}
            </span>
            <button type="button" aria-label="Next month" onClick={() => changeMonth(1)}>
              ›
            </button>
          </div>

          <div className="date-picker-weekdays">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="date-picker-grid">
            {cells.map((cell) => {
              const outside = cell.getMonth() !== viewDate.getMonth();
              const isSelected = isSameDay(cell, selected);
              const isToday = isSameDay(cell, today);
              return (
                <button
                  type="button"
                  key={cell.toISOString()}
                  className={`date-picker-day${outside ? ' is-outside' : ''}${isToday ? ' is-today' : ''}`}
                  aria-pressed={isSelected}
                  aria-label={cell.toDateString()}
                  onClick={() => pickDay(cell)}
                >
                  {cell.getDate()}
                </button>
              );
            })}
          </div>

          <div className="date-picker-footer">
            <button type="button" onClick={() => onChange('')}>
              Clear
            </button>
            <button type="button" onClick={() => pickDay(new Date())}>
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
