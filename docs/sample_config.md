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
        displayStyle: "fit-region", // Choose one:
                                    // "wallpaper" (stretches to fill region) will add a duplicate option called "fill" in a future release and sunset this option for better clarity.
                                    // "fit-region" (maintains aspect ratio)
                                    // "absolute" (fixed size based on one edge)
        applyBlur: false,           // Adds a blurred background in empty spaces
        // Only used when displayStyle is "absolute", omit if not using absolute mode
        absoluteOptions: {           
            enabled: false,
            side: "horizontal",      // "horizontal" = fixed width, "vertical" = fixed height
            size: 400,               // Size in pixels for the fixed dimension
            blurContainer: {
                width: 500,          // Only used if applyBlur is true and displayStyle is absolute
                height: 500          // Defines the size of the blur effect container
            }
        },
        // Photo Order Options
        displayOrder: "random",     // Choose one:
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
            relativeTo: "display"    // "display" or "image" 
                                     // defines where the corners for attribution are relative to. in wallpaper mode the image is the wallpaper you should select "display" or the pill will be at the original corners of the photo pre-streching. this will be fixed in a future release.
        },
        selfieUploads: false,  // Whether to process and upload photos from MMM-Selfieshot
        selfieFolder: "selfies" // S3 folder name for selfieshot uploads
    }
}
```
