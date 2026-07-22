const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

export default function PasswordStrengthMeter({ strength }) {
  if (!strength) {
    return null;
  }

  const { score, warning, suggestions } = strength;

  return (
    <div aria-live="polite">
      <div role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={4} aria-label="Password strength">
        Password strength: {LABELS[score] ?? 'Unknown'}
      </div>
      {warning ? <p>{warning}</p> : null}
      {suggestions?.length ? (
        <ul>
          {suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
