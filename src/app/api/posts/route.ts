// app/api/posts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { PrismaClient, Visibility, Category, TAGS } from '@prisma/client';
import { moveFileFromTemp, generateFinalKey, extractKeyFromUrl } from '@/lib/aws-s3';

const prisma = new PrismaClient();

interface FileData {
  s3Key: string;
  description: string;
  fileName: string;
  fileType: string;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession();
    
    if (!session?.user?.email) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const {
      title,
      description,
      category,
      tags,
      visibility,
      isDraft,
      coverImage,
      files
    } = await request.json();

    // Validate required fields
    if (!title || !description || !category || !files || files.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { email: session.user.email }
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Create post first
    const post = await prisma.post.create({
      data: {
        title,
        description,
        category: category as Category,
        tags: tags as TAGS[],
        visibility: visibility as Visibility,
        isDraft,
        userId: user.id,
        coverImage: '', // We'll update this after moving files
      }
    });

    try {
      // Move files from temp to final location and create Image records
      const movedFiles: string[] = [];
      
      for (const file of files as FileData[]) {
        try {
          // Generate final key based on visibility
          const finalKey = generateFinalKey(
            user.id,
            post.id,
            file.fileName,
            visibility
          );

          // Move file from temp to final location
          const finalUrl = await moveFileFromTemp(file.s3Key, finalKey);
          movedFiles.push(finalUrl);

          // Create Image record
          await prisma.image.create({
            data: {
              url: finalUrl,
              description: file.description || null,
              postId: post.id
            }
          });

        } catch (fileError) {
          console.error(`Error processing file ${file.fileName}:`, fileError);
          // Continue with other files, but log the error
        }
      }

      // Update post with cover image if provided
      let finalCoverImage = '';
      if (coverImage) {
        // Find the corresponding moved file
        const coverFile = files.find((f: FileData) => 
          coverImage.includes(f.s3Key.split('/').pop() || '')
        );
        
        if (coverFile) {
          const coverFinalKey = generateFinalKey(
            user.id,
            post.id,
            coverFile.fileName,
            visibility
          );
          finalCoverImage = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${coverFinalKey}`;
        }
      }

      // Update post with final cover image
      const updatedPost = await prisma.post.update({
        where: { id: post.id },
        data: {
          coverImage: finalCoverImage || movedFiles[0] || null // Use first image as cover if none specified
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              avatar: true
            }
          },
          images: true,
          _count: {
            select: {
              likes: true,
              comments: true
            }
          }
        }
      });

      return NextResponse.json({
        message: 'Post created successfully',
        post: updatedPost
      });

    } catch (fileProcessingError) {
      console.error('File processing error:', fileProcessingError);
      
      // If file processing fails, we should clean up the post
      await prisma.post.delete({
        where: { id: post.id }
      });

      return NextResponse.json(
        { error: 'Failed to process uploaded files' },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('Post creation error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 50);
    const visibility = searchParams.get('visibility') as Visibility;
    const category = searchParams.get('category') as Category;
    const userId = searchParams.get('userId');

    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {
      isDraft: false // Only show published posts by default
    };

    if (visibility) {
      where.visibility = visibility;
    }

    if (category) {
      where.category = category;
    }

    if (userId) {
      where.userId = userId;
    }

    // Get session to check if user can see private/followers posts
    const session = await getServerSession();
    
    if (!session?.user?.email) {
      // Not authenticated, only show public posts
      where.visibility = Visibility.PUBLIC;
    } else {
      // Authenticated, but still filter based on visibility rules
      if (!userId) { // If not looking at specific user's posts
        const user = await prisma.user.findUnique({
          where: { email: session.user.email }
        });

        if (user) {
          // Show public posts + user's own posts + followers posts from people they follow
          where.OR = [
            { visibility: Visibility.PUBLIC },
            { userId: user.id }, // User's own posts
            {
              AND: [
                { visibility: Visibility.FOLLOWERS },
                {
                  user: {
                    followers: {
                      some: {
                        followerId: user.id
                      }
                    }
                  }
                }
              ]
            }
          ];
        }
      }
    }

    const posts = await prisma.post.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatar: true
          }
        },
        images: true,
        _count: {
          select: {
            likes: true,
            comments: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: limit
    });

    const total = await prisma.post.count({ where });

    return NextResponse.json({
      posts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Posts fetch error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}