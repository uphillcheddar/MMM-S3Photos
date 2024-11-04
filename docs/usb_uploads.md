### USB Upload Instructions:
Note: all folders and file names bust be compliant with s3 naming conventions. See here for more details: [S3 Object Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html)

1. **Connect USB storage device to your Raspberry Pi**
2. **SSH into your Pi or open a local terminal**
3. **Navigate to the module directory:**
   ```bash
   cd ~/MagicMirror/modules/MMM-S3Photos
   ```
4. **Run the upload script:**
   ```bash
   node upload_from_usb.js
   ```
5. **Follow the interactive prompts to:**
   - Select your USB device
   - Choose which folders to upload
   - Wait for the upload to complete
   - Safely remove your device

Behind the scenes the script will:
* Copy selected photos to local cache
* Upload photos to your S3 bucket (retaining folder structure)
* Safely eject your device


## Photo Organization
Photos in your S3 bucket can be organized in folders. The folder names can be used for attribution display if enabled.

Example structure:
```
bucket/
├── vacation/
│   ├── photo1.jpg
│   └── photo2.jpg
└── family/
    ├── photo3.jpg
    └── photo4.jpg
```