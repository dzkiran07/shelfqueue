export default function Wordmark({ size = 'md' }) {
  return (
    <span className={`wordmark${size === 'lg' ? ' wordmark-lg' : ''}`}>
      <span className="wordmark-text">
        <span className="wordmark-shelf">Shelf</span>
        <span className="wordmark-queue">Queue</span>
      </span>
    </span>
  );
}
