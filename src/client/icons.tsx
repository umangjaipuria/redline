// Topbar / chrome icons, lifted from the main-branch markup so the UI matches.

export const BrandMark = () => (
  <svg viewBox="0 0 32 32" fill="none" width="28" height="28" aria-hidden="true">
    <defs>
      <linearGradient id="brandInk" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
        <stop stop-color="#df4628" />
        <stop offset="1" stop-color="#a81f0c" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="30" height="30" rx="8.5" fill="#fbf6ed" />
    <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="none" stroke="#000" stroke-opacity="0.07" />
    <path d="M7.4 23.2c5.1-3.3 12.2-9.3 18.8-15.4-2.7 5.8-8.1 11.7-13.9 15.4 2.5-.3 5-1.3 7.5-3-2.9 3-6.9 4.9-11.5 4.7-.5 0-.9-1.1-.9-1.7Z" fill="url(#brandInk)" />
  </svg>
);

export const OpenIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 8V6.2A1.7 1.7 0 0 1 5.7 4.5H9l2 2h6.3A1.7 1.7 0 0 1 19 8.2" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
    <path d="M3.2 9.5h17.2l-2.1 8.3a1 1 0 0 1-1 .7H6.3a1 1 0 0 1-1-.7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
  </svg>
);

export const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" width="34" height="34" aria-hidden="true">
    <path d="M4 8V6.2A1.7 1.7 0 0 1 5.7 4.5H9l2 2h6.3A1.7 1.7 0 0 1 19 8.2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
    <path d="M3.2 9.5h17.2l-2.1 8.3a1 1 0 0 1-1 .7H6.3a1 1 0 0 1-1-.7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
  </svg>
);

export const PersonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" width="15" height="15" aria-hidden="true">
    <circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.7" />
    <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  </svg>
);

export const ChevronLeftIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m11 7-5 5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="m18 7-5 5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const ChevronRightIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m6 7 5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path d="m13 7 5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const RailIcon = () => (
  <svg class="btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="14" rx="2.2" stroke="currentColor" stroke-width="1.8" />
    <path d="M14.5 5v14" stroke="currentColor" stroke-width="1.8" />
    <path class="rail-toggle-fill" d="M14.9 5.4h3.4a1.8 1.8 0 0 1 1.8 1.8v9.6a1.8 1.8 0 0 1-1.8 1.8h-3.4z" fill="currentColor" stroke="none" />
  </svg>
);
