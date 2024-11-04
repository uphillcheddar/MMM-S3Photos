# AWS Account Creation Steps

How to create an AWS account and setup the infrastructure for the MMM-S3Photos module.

* Step 1: Create an AWS Account link [here](https://aws.amazon.com/free/) (if you don't already have one)
* Step 2: Create an IAM user 
  * navigate to the [IAM console](https://us-east-1.console.aws.amazon.com/iamv2/home?region=us-east-1#/users)
  * click on "Create user" [Screenshot](../screenshots/create_new_user.png)
  * enter a name like "MMM-S3PhotosUser"
  * click on "Next"
  * choose "Attach existing policies directly"[Screenshot](../screenshots/attach_admin_policy.png)
  * select "AdministratorAccess" from the list of policies
  * click on "Next"
  * click on "Create user"
* Step 3: create an access key for the user
  * From IAM dashboard, click on the user you just created [Screenshot](../screenshots/select_user.png)
  * click on "Security credentials" tab
  * click on "Create access key" [Screenshot](../screenshots/create_access_key.png)
  * Select Application Running Outside of AWS [Screenshot](../screenshots/select_usecase.png)
  * click on "Next"
  * click on "Create access key"
  * (Optional) add a tag if you'd like [Screenshot](../screenshots/set_key_tag.png)
  * click on "Next"
  * click on "Create access key"
  * click on "Show access key"
  * take note of key values (download the csv file incase you need it later) [Screenshot](../screenshots/download_copy_key.png)
* Step 4: setup the infrastructure 
  * SHH into raspberry pi
  * go to MMM-S3Photos folder
     ```bash
     cd ~/MagicMirror/modules/MMM-S3Photos
     ```
* Step 5: Setup
  *  run setup script
     ```bash
     sudo node ./setup.sh
     ```
