import { useState } from 'react';
import PropTypes from 'prop-types';
import { initialOf } from '../lib/profile';

// Profile photo (a short-lived signed URL from the private bucket) or the
// initial. If the image fails to load (expired URL, deleted file) it falls back
// to the initial instead of showing a broken image.
const Avatar = ({ name, url, size = 32 }) => {
  const [failedUrl, setFailedUrl] = useState(null);
  const showImage = Boolean(url) && failedUrl !== url;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {showImage ? <img src={url} alt="" onError={() => setFailedUrl(url)} draggable={false} /> : initialOf(name)}
    </span>
  );
};

Avatar.propTypes = { name: PropTypes.string, url: PropTypes.string, size: PropTypes.number };
export default Avatar;
