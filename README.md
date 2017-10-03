# dat-container

Container runtime for Dat

```
npm install -g dat-container
```

Requires systemd-nspawn and fuse installed.

## Usage

One a host (linux) machine allocate a sparse file, format it, mount it, and install a distro inside, and unmount it

``` sh
# installing arch from arch
fallocate -l 1000000000 arch.img
mkfs.ext4 arch.img
mkdir -p mnt
sudo mount arch.img mnt
sudo pacstrap mnt base
sudo umount mnt
```

You can now boot this image using systemd-nspawn using the following command to modify it more

``` sh
sudo systemd-nspawn -i arch.img -b
```

When you are done add this image to a Dat (you can add more than one)
and start sharing the Dat

## Live booting the image using Dat

You are now ready to boot the image over Dat.
On a guest machine simply install dat-container and run

``` sh
# do a full container boot
sudo dat-container -i arch.img --key <dat-key-from-above> -b
```

That's it! The image will now live boot over the network!

To run a single command (also live)

```
# run uname -a
sudo dat-container -i arch.img --key <dat-key-from-above> -- uname -a
```

Any argument prefixed with `--sn-` is automatically forwarded to systemd-nspawn.

## How can I help?

This tool needs more cool options, features, and documentation.
All help is appreciated.

## Created files look big?

Don't worry. All files are usually very sparse and small on disk even though
they look like they take up gigabytes of space. To see the actual size run

```
# show actual blocks used on disk as the first column
ls -shl
```

## License

MIT
