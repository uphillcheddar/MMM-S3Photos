# MMM-S3Photos

A MagicMirror² module that displays photos from an AWS S3 bucket with various display options and automatic synchronization.

This module was created as a result of Google Photos crippling their API and limiting how you can access your own data. While AWS is not free like Google Photos, it does provide a more open and flexible platform for storing and accessing your photos. And if configured properly, can be very inexpensive to run. My set up has a monthly cost of ~$0.60 thats not a typo 60 CENTS! if you are on the free tier it will be even cheaper. see cost breakdown for more details.

## Buy me a coffee
I'm a overworked, and underpaid, tech worker in the analytics and intelligence industry. I spend my free time creating and sharing side projects like MagicMirror modules and 3D printing STL files with the community. If you enjoy my work and want to support future projects, buy me a coffee! ☕

[Buy me a coffee](https://buymeacoffee.com/uphillcheddar)

## Features
- **Automated AWS Infrastructure Setup**
  - Script handles creating S3 bucket, Lambda function, and related invocation roles.
- **Configurable display duration**
   - Minimum 10 seconds recommended
- **Multiple display styles:**
  - Wallpaper (full screen)
  - Fit-region (maintains aspect ratio)
  - Absolute (fixed size)
- **Optional blur effect for empty space**
- **Multiple display order options:**
  - Random 
  - Random with deduplication <- displays all photos once before repeating
  - Newest first
  - Oldest first
- **Optional attribution overlay with configurable positioning**
  - Static (fixed position)
  - Dynamic (random position)
- **Photo upload from USB storage device**
   - Script based uploads to S3 bucket, maintains folder structure.
   - Safely ejects USB device
- **Optional selfieshot uploads from MMM-Selfieshot**
   - Uploads selfies taken from the MMM-Selfieshot module to S3 bucket.
- **Delta Updates**: 
   - Only downloads new or modified photos, reducing bandwidth usage
- **Configurable Cache Lifetime**: 
   - Set `cacheLifeDays: 0` for permanent cache
   - Set `cacheLifeDays: N` to automatically purge cache every N days < - NOT RECOMMENDED



# AWS Costs

This module uses AWS services that may incur charges.

Example details:
- 10GB of photos
- Hourly sync requests 
- No cache wipes <-this one is important, wiping the cache is the bigest potental cost driver. Note there should be no reason to wipe the cache as the module will prune photos that have been deleted from the S3 bucket, but if your use case involves photos with the same file name and a need to regularly purge the cache feature is available.

## Breakdown for the free tier:

### S3 Storage
- First 5GB per month: FREE
- $0.023 per GB/month after first 5GB (5 x $0.023)
- S3 Total~$0.35/month

### Lambda Function
- First 1 million requests per month: FREE
- 128MB memory allocation
- Typically runs once per hour = ~720 requests/month
- Lambda total $0.00/month FREE!

### Data Transfer
- 10GB (each photo transfered once)
   - Module only downloads new/modified photos (delta updates) so this usuage is only incured once per photo unless you wipe the cache.
- 100GB transfer included in free tier 
- Total $0.00/month: FREE!

### Grand Total- For most users, on the aws free tier, this module will cost ~$.30 Cents per month.

## No free tier?
 The cost will be about the same as the free tier on a monthly basis. Howwever the first month will be ~$1.00 as you will not have the advantage of the free tier data transfer. So the inital load will hit you for about 40 cents. But after that you will only pay about $0.60 per month. 
 
 Lambda functions are essentially free for our usecase as they are billed per million invocations and even if you are not on the free tier they'll round down to $0.00
 
**Note: These prices are for the US regions as of 10-2024 Other regions may vary. Check [AWS Pricing](https://aws.amazon.com/pricing/) for current rates in your region.**

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

## To Do / Wish List / On the Back Burner
* Video? Pi3B is limited to 720p due to resources and 4+ would around 1080p not sure if its worth supporting video

# Installation instructions
 * ssh into raspberry pi
 * go to Magic Mirror modules folder
   ```bash
   cd ~/MagicMirror/modules
   ```
 * clone the repository
   ```bash
   git clone https://github.com/uphillcheddar/MMM-S3Photos.git
   ```
 * create aws account and setup IAM user and access key see [AWS Account Creation Steps](docs/aws_account_creation_steps.md)
 * run setup script
   ```bash
   sudo node ~/MagicMirror/modules/MMM-S3Photos/setup.js
   ```
* ! After Setup is complete return to aws console and reduce permissions of the IAM user (a template for permissions is generated by the setup script that can be used to reduce permissions)

# Sample Configuration

Add the module to your `config.js` file:

```javascript
{
    module: "MMM-S3Photos",
    position: "fullscreen_below",    // standard Magic mirror regions (fullscreen_below should be used if setting wallpaper as display style)
    config: {
        syncTimeHours: 1,           // How often to check for new photos (1 = hourly)
        cacheLifeDays: 0,           // 0 = never clean cache, otherwise days between cache purges
        displayDurationSeconds: 60,  // How long to show each photo
        
        // Display Style Options
        displayStyle: "fit-region",   // Choose one:
                                    // "wallpaper" (fills screen)
                                    // "fit-region" (maintains aspect ratio)
                                    // "absolute" (fixed size)
        applyBlur: false,           // Adds a blurred background in empty spaces
        // Only used when displayStyle is "absolute"
        absoluteOptions: {
            enabled: false,
            side: "horizontal",      // "horizontal" = fixed width, "vertical" = fixed height
            size: 400,              // Size in pixels for the fixed dimension
            blurContainer: {
                width: 500,         // Only used if applyBlur is true and displayStyle is absolute
                height: 500         // Defines the size of the blur effect container
            }
        },
        // Photo Order Options
        displayOrder: "random",      // Choose one:
                                    // "random" (completely random)
                                    // "random_dedupe" (won't repeat until all photos are shown)
                                    // "newest_first" (chronological, newest photos first)
                                    // "oldest_first" (chronological, oldest photos first)
        // Attribution Settings
        attribution: {
            enabled: false,          // Set to true to show photo information based on folder names
            attributions: {
                "vacation_folder": "Summer 2023",     // In this example: "vacation_folder" is the folder name and "Summer 2023" will be displayed.
                "family_folder": "Family Photos"      // In this example: "family_folder" is the folder name and "Family Photos" will be displayed.
            },
            position: "static",      // Position of atribution pill label 
                                     // "static" = fixed position
                                     // "dynamic" = randomly changes position, truelly random may repeate for sevaral photos in a row
            corner: "bottom-right"   // Choose one (ignored if position is "dynamic"):
                                     // "top-left"
                                     // "top-right"
                                     // "bottom-left"
                                     // "bottom-right"
            relativeTo: "display"    // "display" or "image" defines where the corners are relative to
        },
        selfieUploads: false,  // Whether to process and upload photos from MMM-Selfieshot
        selfieFolder: "selfies" // S3 folder name for selfieshot uploads
    }
}
```


## Troubleshooting

### Common Issues

**Clock hard to read**

Add this to your ~/MagicMirror/css/custom.css file:
```css
.clock {
  padding: 10px;
  background-color: rgba(0, 0, 0, 0.5);
}
```

**Permission Errors**
   ```bash
   sudo chmod 755 ~/MagicMirror/modules/MMM-S3Photos/cache
   sudo chmod 644 ~/MagicMirror/modules/MMM-S3Photos/cache/photos.json
   ```

**AWS Credentials**
   - Verify credentials in `local_aws-credentials` or run setup.js again and chose not to use existing credentials. (this will create a new credential file)
   - Ensure IAM user has appropriate permissions

**Photo Loading**
   - Check network connectivity
   - Verify S3 bucket permissions
   - Review module logs in MagicMirror console



## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss proposed changes.

## License

[MIT](LICENSE)


