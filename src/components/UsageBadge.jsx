import PropTypes from 'prop-types';

// Guests always see their remaining free questions; signed-in users only see a
// hint when the daily allowance is running low (details live in Settings).
const UsageBadge = ({ kind, usage }) => {
  if (!usage || typeof usage.remaining !== 'number') return null;
  if (kind === 'guest') {
    return (
      <span className={`usage-badge ${usage.remaining === 0 ? 'is-empty' : ''}`} title="Free questions left for guests">
        {usage.remaining} of {usage.limit} free questions left
      </span>
    );
  }
  if (usage.remaining > 10 && usage.remaining > usage.limit * 0.1) return null;
  return <span className="usage-badge" title="Questions left today">{usage.remaining} left today</span>;
};
UsageBadge.propTypes = { kind: PropTypes.string, usage: PropTypes.shape({ remaining: PropTypes.number, limit: PropTypes.number }) };
export default UsageBadge;
