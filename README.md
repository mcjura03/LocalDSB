# LocalDSB
A local PDF-Viewing kiosk based on JavaScript, intended to be used in kiosk applications, e.g. in schools to display information for students. Currently this project is mainly targeted at German speaking users. Translated versions might follow. Use this software purely at your own risk. Its tested quite well by now - but certainly not perfect. 

# Summary

This repository hosts the server side of a tool used to display two sets of pdf-files side by side. It is mainly intended for situations similar to the following:

A school wants to display plans for teacher substitiution locally on a kiosk-style display. Announcements can also be made via a scrolling text banner on the bottom of the page. 
To make the transfer of the PDFs easier and allow collaboration, you can mount a network share and point your paths for the left and right side to that. 

To discourage abuse, PIN can be set for the scrolling text-edit and a httpAuth authentification is required for the admin panel (both are not quite as securely managed as id like - for now, both are stored in plain text on the server. This is subject to change.)

Kiosks should be able to be refreshed from the admin-panel. 

There might be a memory-leak in the client-side javascript for now. In testing, the client side only (for a 24h application) ran smoothly for about 2 or 3 days nonstop, without manually refreshing the tab. When restarting the browser at least once a day, no runtime-limits have been found (yet), so 30 days + should not be a problem. This could also be a browser-cache-hogging phenomenon, as it seems to only be a problem on chomium-based clients.

# Installation
## Server

### Dependencies

The server runs as a NodeJS script via npm. Running it on a windows machine is possible, yet discouraged for stability-reasons. 

Make sure, you have all the reqiured dependencies for, as well as NodeJS installed on your system. 

If you want to use a network share, ideally mount it permanantly before you continue. Make sure you follow best practices if you use any authentification - this highly depends on your environment. Make sure, the PDF-source+path is always accesible *before* the server starts, as it will not successfully do so otherwise!

If you want to share the folders from your server, make sure to set some form of authentification as a requirement, to avoid abuse.

### Setup

Clone the contents of this repo into a folder on your server. You should just be able to start the server up via:
```
npm start
```
Make sure you are *inside* the folder your server.js lies in.

The standard port for this tool is 3000 - the webinterface should already be accesible at:
```
http://your-hostname:3000
```
or 
```
http://localhost:3000
```

You should be able to change the port to nearly anything you want. Make sure there are no collisions in your case tho! Be especially careful, if your server also hosts other sites via nginx or similar.

Ideally you should run the server as a service or by other means directly at (or shortly after) booting. Make sure to follow the recomandations for your server to do that. Adding it via systemd to run at startup seems to work best under Debian 13. Especially using Windows would be quite different here tho.


### Customization

You can freely change the background (*bg.jpg*) and logo (*logo.jpg*) files in:
```
/your/install/path/public/
```
Make sure to change the filenames in:
```
/your/install/path/public/index.html
```
and 
```
/your/install/path/data/config.json
```

accordingly, if applicable.

Other customizations can be made via:
```
/your/install/path/data/config.json
```
too, such as flip-timing, PDF-path and the PIN and Admin-PW.

The admin page allows the changing of some of these options too, and can be found at:
```
http://your-hostname:3000/admin.html
```
using *administrator* and your chosen PW to authenticate.

Changing the scrolling text can be done via:
```
http://your-hostname:3000/ticker.html
```
again, using the PIN set in the config-file.

## Kiosk
### Setup

Use a kiosk-browser solution of your choice. The page should be manually reloaded at least once a day! It would be best to restart the whole browser to clean up any chached bitmaps, etc.


## Security-Precautions

This tool is deliberately built to be run inside of local area networks ONLY. Especially for schools, which might have different VLANs for students and teachers, this brings a layer of data privacy not possible when using outside hosting services. 
This tool however also relies on the structure of your network to function safely. 

A (very) non-complete list of precautions would be:
- Make sure your server is not accessible via ssh from outside, and all users on said server are secured (at least) by using a secure password [DUH!]!
- Have all your kiosk-devices, the server and if applicable the network-storage-device in a separate (V)LAN or only add a route to the server on port 3000, if your kiosk-displays have to be in a "public" network.
- Make absolutely sure to have some kind of authentification, if you use a network drive for your PDFs, especially if the fileserver is "publicly visible" to e.g. students.
- Most importantly: check my code, before you deploy it... I'm just as human as any of us, so use caution and maybe fix some stupid mistakes I made along the way. Have fun!
