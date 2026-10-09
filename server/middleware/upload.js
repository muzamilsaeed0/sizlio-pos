const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'restaurant-pos',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
  },
});

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

module.exports = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB maximum logo upload
    files: 1
  },
  fileFilter: (req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      const error = new Error('Only JPG, PNG, and WebP images are allowed');
      error.code = 'INVALID_LOGO_TYPE';
      return callback(error);
    }

    callback(null, true);
  }
});